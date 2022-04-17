import {
  createLoggingContext,
  createRequestContext,
  delay,
  jsonifyError,
  RequestContext,
  RequestContextWithTransactionId,
  safeJsonStringify,
} from "@connext/nxtp-utils";
import { BigNumber, providers } from "ethers";

import { getContext } from "../../router";
import {
  ActiveTransaction,
  CrosschainTransactionStatus,
  FulfillPayload,
  PreparePayload,
  Tracker,
  attemptedTransfer,
  completedTransfer,
  successfulAuction,
  senderFailedCancel,
  receiverFailedPrepare,
  senderFailedFulfill,
  receiverExpired,
  senderExpired,
  receiverFailedCancel,
  senderPrepared,
  receiverPrepared,
  receiverFulfilled,
  senderFulfilled,
  senderCancelled,
  receiverCancelled,
  ActiveTransactionsTracker,
} from "../../lib/entities";
import { getOperations } from "../../lib/operations";
import { ContractReaderNotAvailableForChain } from "../../lib/errors";
import { incrementFees } from "../../lib/helpers";
import { getAssetName, incrementTotalTransferredVolume } from "../../lib/helpers/metrics";
import { getFeesInSendingAsset } from "../../lib/helpers/shared";

const LOOP_INTERVAL = 30_000;
export const getLoopInterval = () => LOOP_INTERVAL;

export const handlingTracker: Map<string, Tracker> = new Map();
export let activeTransactionsTracker: ActiveTransactionsTracker[] = [];

export const bindContractReader = async () => {
  const { contractReader, logger, config } = getContext();
  setInterval(async () => {
    const { requestContext, methodContext } = createLoggingContext("bindContractReader");
    let transactions: ActiveTransaction<any>[] = [];
    try {
      transactions = await contractReader.getActiveTransactions();
      if (transactions.length > 0) {
        activeTransactionsTracker = transactions.map((v) => {
          return {
            status: v.status,
            transactionsId: v.crosschainTx.invariant.transactionId,
            sendingChainId: v.crosschainTx.invariant.sendingChainId,
            receivingChainId: v.crosschainTx.invariant.receivingChainId,
          };
        });

        logger.info("Trackers overview", requestContext, methodContext, {
          activeTransactionsLength: transactions.length,
          handlingTrackerLength: handlingTracker.size,
        });
        logger.debug("Trackers detailed", requestContext, methodContext, {
          handlingTrackerLength: handlingTracker.size,
          handlingTracker: [...handlingTracker],
          activeTransactionsTracker,
        });
      }
    } catch (err: any) {
      logger.error("Error getting active txs, waiting for next loop", requestContext, methodContext, jsonifyError(err));
      return;
    }

    // handle the case for `ReceiverFulfilled` -- in this case, the transaction will *not*
    // be re-processed from the loop because the next logical status is `SenderFulfilled`,
    // which is not recognized as an "active transaction". instead, the transaction
    // should be removed from the tracker completely to avoid a memory leak
    Object.entries(config.chainConfig).forEach(async ([chainId]) => {
      const records = await contractReader.getSyncRecords(Number(chainId));
      const highestSyncedBlock = Math.max(...records.map((r) => r.syncedBlock));
      handlingTracker.forEach((value, key) => {
        if (
          value.chainId === Number(chainId) &&
          value.block > 0 &&
          value.block <= highestSyncedBlock &&
          value.status === "ReceiverFulfilled"
        ) {
          logger.debug("Deleting tracker record", requestContext, methodContext, {
            transactionId: key,
            chainId: chainId,
            blockNumber: value.block,
            syncedBlock: highestSyncedBlock,
          });
          handlingTracker.delete(key);
        }
      });
    });

    await handleActiveTransactions(transactions);
  }, getLoopInterval());
};

export const handleActiveTransactions = async (
  transactions: ActiveTransaction<any>[],
  _requestContext?: RequestContext,
) => {
  const { logger } = getContext();
  for (const transaction of transactions) {
    const { requestContext, methodContext } = createLoggingContext(
      handleActiveTransactions.name,
      typeof _requestContext === "object"
        ? { ..._requestContext, transactionId: transaction.crosschainTx.invariant.transactionId }
        : undefined,
      transaction.crosschainTx.invariant.transactionId,
    );

    // chainId where onChain interaction will happen
    let chainId: number;
    if (
      transaction.status === CrosschainTransactionStatus.SenderPrepared ||
      transaction.status === CrosschainTransactionStatus.SenderExpired
    ) {
      chainId = transaction.crosschainTx.invariant.receivingChainId;
    } else {
      chainId = transaction.crosschainTx.invariant.sendingChainId;
    }

    // check if transactionId is already handled for respective chainId
    if (
      handlingTracker.has(transaction.crosschainTx.invariant.transactionId) &&
      (transaction.status === handlingTracker.get(transaction.crosschainTx.invariant.transactionId)?.status ||
        handlingTracker.get(transaction.crosschainTx.invariant.transactionId)?.status === "Processing")
    ) {
      logger.debug("Already handling transaction", requestContext, methodContext, { status: transaction.status });
      continue;
    }

    handlingTracker.set(transaction.crosschainTx.invariant.transactionId, {
      status: "Processing",
      chainId,
      block: -1,
    });

    handleSingle(transaction, requestContext)
      .then((result) => {
        logger.debug("Handle Single Result", requestContext, methodContext, { transactionResult: result });

        if (result && result.blockNumber) {
          handlingTracker.set(transaction.crosschainTx.invariant.transactionId, {
            status: transaction.status,
            chainId,
            block: result.blockNumber,
          });
        } else {
          handlingTracker.delete(transaction.crosschainTx.invariant.transactionId);
        }
      })
      .catch((err) => {
        logger.debug("Handle Single Errors", requestContext, methodContext, { error: jsonifyError(err) });
        handlingTracker.delete(transaction.crosschainTx.invariant.transactionId);
      });
    await delay(750); // delay here to not flood the provider
  }
};

export const handleSingle = async (
  transaction: ActiveTransaction<any>,
  _requestContext: RequestContextWithTransactionId,
): Promise<providers.TransactionReceipt | undefined> => {
  const { requestContext, methodContext } = createLoggingContext(
    handleSingle.name,
    _requestContext,
    transaction.crosschainTx.invariant.transactionId,
  );
  const { logger, txService, config, cache } = getContext();
  const { prepare, cancel, fulfill } = getOperations();

  let receipt: providers.TransactionReceipt | undefined;
  if (transaction.status === CrosschainTransactionStatus.SenderPrepared) {
    const _transaction = transaction as ActiveTransaction<"SenderPrepared">;
    const chainConfig = config.chainConfig[_transaction.crosschainTx.invariant.sendingChainId];
    if (!chainConfig) {
      // this should not happen, this should get checked before this point
      throw new ContractReaderNotAvailableForChain(_transaction.crosschainTx.invariant.sendingChainId, {
        methodContext,
        requestContext,
      });
    }
    if (!_transaction.payload.hashes.sending) {
      logger.warn("No sending hashes with SenderPrepared status", requestContext, methodContext, {
        hashes: _transaction.payload.hashes,
      });
      return;
    }
    const senderPrepareReceipt = await txService.getTransactionReceipt(
      _transaction.crosschainTx.invariant.sendingChainId,
      _transaction.payload.hashes.sending.prepareHash,
    );
    if ((senderPrepareReceipt?.confirmations ?? 0) < chainConfig.confirmations) {
      logger.info("Waiting for safe confirmations", requestContext, methodContext, {
        txConfirmations: senderPrepareReceipt?.confirmations ?? 0,
        configuredConfirmations: chainConfig.confirmations,
        chainId: _transaction.crosschainTx.invariant.sendingChainId,
        txHash: _transaction.payload.hashes.sending.prepareHash,
      });
      return;
    }
    const preparePayload: PreparePayload = _transaction.payload;
    try {
      logger.info("Preparing receiver", requestContext, methodContext, {
        senderPrepareTransaction: {
          transactionHash: senderPrepareReceipt.transactionHash,
          block: senderPrepareReceipt.blockNumber,
          confirmations: senderPrepareReceipt.confirmations,
        },
      });
      // We need to confirm in the cache that this bid was accepted by the user and we are
      // going through with our commitment to prepare on the receiving chain. The bid may expire in
      // the time it takes to send the prepare transaction, but doing so ensures the cache extends
      // the outstanding liquidity reservation for that time.
      // See the `finally` block below for the `removeBid` operation that releases the outstanding liquidity.
      const didConfirm = cache.auctions.confirmBid(
        _transaction.crosschainTx.invariant.receivingChainId,
        _transaction.crosschainTx.invariant.receivingAssetId,
        _transaction.crosschainTx.invariant.transactionId,
      );
      if (!didConfirm) {
        logger.warn("Unable to confirm bid to extend liquidity reservation", requestContext, methodContext, {
          didConfirm,
          receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
          receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
          transactionId: _transaction.crosschainTx.invariant.transactionId,
          receivingAmount: _transaction.crosschainTx.receiving?.amount,
        });
      }
      receipt = await prepare(
        _transaction.crosschainTx.invariant,
        {
          senderExpiry: _transaction.crosschainTx.sending.expiry,
          senderAmount: _transaction.crosschainTx.sending.amount,
          bidSignature: preparePayload.bidSignature,
          encodedBid: preparePayload.encodedBid,
          encryptedCallData: preparePayload.encryptedCallData,
        },
        requestContext,
      );
      // if successfully prepared, was successful auction, sender/receiver prepare
      const sendingAssetName = getAssetName(
        _transaction.crosschainTx.invariant.sendingAssetId,
        _transaction.crosschainTx.invariant.sendingChainId,
      );
      const receivingAssetName = getAssetName(
        _transaction.crosschainTx.invariant.receivingAssetId,
        _transaction.crosschainTx.invariant.receivingChainId,
      );
      successfulAuction.inc(
        {
          sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
          receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
          sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
          receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
          sendingAssetName,
          receivingAssetName,
        },
        1,
      );
      senderPrepared.inc({
        sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
        sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
        receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
        receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
        assetName: sendingAssetName,
      });
      receiverPrepared.inc({
        sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
        sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
        receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
        receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
        assetName: receivingAssetName,
      });
      logger.info("Prepared receiver", requestContext, methodContext, { txHash: receipt?.transactionHash });
      attemptedTransfer.inc({
        sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
        receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
        sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
        receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
        sendingAssetName,
        receivingAssetName,
      });
    } catch (err: any) {
      const sendingAssetName = getAssetName(
        _transaction.crosschainTx.invariant.sendingAssetId,
        _transaction.crosschainTx.invariant.sendingChainId,
      );
      const receivingAssetName = getAssetName(
        _transaction.crosschainTx.invariant.receivingAssetId,
        _transaction.crosschainTx.invariant.receivingChainId,
      );
      receiverFailedPrepare.inc({
        sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
        receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
        sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
        receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
        assetName: receivingAssetName,
      });
      const json = jsonifyError(err);
      if (safeJsonStringify(json).includes("#P:015")) {
        logger.warn("Receiver transaction already prepared", requestContext, methodContext, { error: json });
        return;
      } else {
        logger.error("Error preparing receiver", requestContext, methodContext, json, {
          chainId: transaction.crosschainTx.invariant.receivingChainId,
        });
      }
      if (err.cancellable === true) {
        logger.warn("Cancellable validation error, cancelling", requestContext, methodContext);
        try {
          const cancelRes = await cancel(
            transaction.crosschainTx.invariant,
            {
              amount: transaction.crosschainTx.sending.amount,
              expiry: transaction.crosschainTx.sending.expiry,
              preparedBlockNumber: transaction.crosschainTx.sending.preparedBlockNumber,
              preparedTransactionHash: transaction.payload.hashes.sending.prepareHash,
              side: "sender",
            },
            requestContext,
          );
          senderCancelled.inc({
            sendingAssetId: transaction.crosschainTx.invariant.sendingAssetId,
            sendingChainId: transaction.crosschainTx.invariant.sendingChainId,
            receivingAssetId: transaction.crosschainTx.invariant.receivingAssetId,
            receivingChainId: transaction.crosschainTx.invariant.receivingChainId,
            assetName: sendingAssetName,
          });
          logger.info("Cancelled transaction", requestContext, methodContext, { txHash: cancelRes?.transactionHash });
          // if successfully cancelled, was successful auction
          successfulAuction.inc(
            {
              sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
              receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
              sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
              receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
              sendingAssetName,
              receivingAssetName: receivingAssetName,
            },
            1,
          );
        } catch (cancelErr: any) {
          senderFailedCancel.inc({
            sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
            receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
            sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
            receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
            assetName: getAssetName(
              _transaction.crosschainTx.invariant.sendingAssetId,
              _transaction.crosschainTx.invariant.sendingChainId,
            ),
          });
          const cancelJson = jsonifyError(cancelErr);
          if (safeJsonStringify(jsonifyError(cancelErr)).includes("#C:019")) {
            logger.warn("Already cancelled", requestContext, methodContext, {
              transaction: _transaction.crosschainTx.invariant.transactionId,
              error: cancelJson,
            });
          } else {
            logger.error("Error cancelling sender", requestContext, methodContext, cancelJson, {
              chainId: transaction.crosschainTx.invariant.sendingChainId,
            });
          }
        }
      }
    } finally {
      // Regardless of whether the prepare executed successfully, we can free up the outstanding liquidity.
      // If it was successful, the liquidity will go from being outstanding, to being locked up for the transaction,
      // and current balance will reflect that.
      cache.auctions.removeBid(
        _transaction.crosschainTx.invariant.receivingChainId,
        _transaction.crosschainTx.invariant.receivingAssetId,
        _transaction.crosschainTx.invariant.transactionId,
      );
    }
  } else if (transaction.status === CrosschainTransactionStatus.ReceiverFulfilled) {
    const _transaction = transaction as ActiveTransaction<"ReceiverFulfilled">;
    const chainConfig = config.chainConfig[_transaction.crosschainTx.invariant.receivingChainId];
    if (!chainConfig) {
      // this should not happen, this should get checked before this point
      throw new ContractReaderNotAvailableForChain(_transaction.crosschainTx.invariant.receivingChainId, {});
    }
    if (!_transaction.payload.hashes?.receiving || !_transaction.payload.hashes?.receiving.fulfillHash) {
      logger.warn("No receiving hashes with ReceiverFulfilled status", requestContext, methodContext, {
        hashes: _transaction.payload.hashes,
      });
      return;
    }

    const receiverFulfillReceipt = await txService.getTransactionReceipt(
      _transaction.crosschainTx.invariant.receivingChainId,
      _transaction.payload.hashes.receiving.fulfillHash,
    );
    if ((receiverFulfillReceipt?.confirmations ?? 0) < chainConfig.confirmations) {
      logger.info("Waiting for safe confirmations", requestContext, methodContext, {
        chainId: _transaction.crosschainTx.invariant.receivingChainId,
        txHash: _transaction.payload.hashes.receiving.fulfillHash,
        txConfirmations: receiverFulfillReceipt?.confirmations ?? 0,
        configuredConfirmations: chainConfig.confirmations,
      });
      return;
    }

    const fulfillPayload: FulfillPayload = _transaction.payload;
    try {
      logger.info("Fulfilling sender", requestContext, methodContext, {
        receiverFulfillTransaction: {
          transactionHash: receiverFulfillReceipt.transactionHash,
          block: receiverFulfillReceipt.blockNumber,
          confirmations: receiverFulfillReceipt.confirmations,
        },
      });
      receipt = await fulfill(
        _transaction.crosschainTx.invariant,
        {
          amount: _transaction.crosschainTx.sending.amount,
          expiry: _transaction.crosschainTx.sending.expiry,
          preparedBlockNumber: _transaction.crosschainTx.sending.preparedBlockNumber,
          signature: fulfillPayload.signature,
          callData: fulfillPayload.callData,
          relayerFee: fulfillPayload.relayerFee,
        },
        requestContext,
      );
      logger.info("Fulfilled sender", requestContext, methodContext, { txHash: receipt?.transactionHash });
      const sendingAssetName = getAssetName(
        _transaction.crosschainTx.invariant.sendingAssetId,
        _transaction.crosschainTx.invariant.sendingChainId,
      );
      const receivingAssetName = getAssetName(
        _transaction.crosschainTx.invariant.receivingAssetId,
        _transaction.crosschainTx.invariant.receivingChainId,
      );
      completedTransfer.inc({
        sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
        receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
        sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
        receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
        sendingAssetName,
        receivingAssetName,
      });
      receiverFulfilled.inc(
        {
          sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
          receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
          sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
          receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
          assetName: receivingAssetName,
        },
        1,
      );
      senderFulfilled.inc(
        {
          sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
          receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
          sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
          receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
          assetName: sendingAssetName,
        },
        1,
      );
      // Update total transferred volume (denominated in receiving asset)
      incrementTotalTransferredVolume(
        _transaction.crosschainTx.invariant.transactionId,
        _transaction.crosschainTx.invariant.sendingAssetId,
        _transaction.crosschainTx.invariant.sendingChainId,
        _transaction.crosschainTx.invariant.receivingAssetId,
        _transaction.crosschainTx.invariant.receivingChainId,
        _transaction.crosschainTx.invariant.receivingAssetId,
        _transaction.crosschainTx.invariant.receivingChainId,
        _transaction.crosschainTx.receiving!.amount,
        requestContext,
      );
      // wrap in promise so it isnt awaited
      const incrementFeesPromise = async () => {
        // Get the fees in sending asset
        // NOTE: may not be exact same rate depending on oracle returns
        const fees = await getFeesInSendingAsset(
          BigNumber.from(_transaction.crosschainTx.receiving!.amount),
          BigNumber.from(_transaction.crosschainTx.sending.amount),
          _transaction.crosschainTx.invariant.sendingAssetId,
          _transaction.crosschainTx.invariant.sendingChainId,
          _transaction.crosschainTx.invariant.receivingAssetId,
          _transaction.crosschainTx.invariant.receivingChainId,
        );
        logger.info("Got fees in sending asset", requestContext, methodContext, {
          receivedAmount: _transaction.crosschainTx.receiving!.amount,
          sentAmount: _transaction.crosschainTx.sending.amount,
          sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
          sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
          receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
          receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
          fees,
        });

        // Add difference between sending and receiving amount
        await incrementFees(
          _transaction.crosschainTx.invariant.transactionId,
          _transaction.crosschainTx.invariant.sendingAssetId,
          _transaction.crosschainTx.invariant.sendingChainId,
          _transaction.crosschainTx.invariant.receivingAssetId,
          _transaction.crosschainTx.invariant.receivingChainId,
          _transaction.crosschainTx.invariant.sendingAssetId,
          _transaction.crosschainTx.invariant.sendingChainId,
          BigNumber.from(fees),
          requestContext,
        );
      };
      incrementFeesPromise();
    } catch (err: any) {
      senderFailedFulfill.inc({
        sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
        receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
        sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
        receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
        assetName: getAssetName(
          _transaction.crosschainTx.invariant.sendingAssetId,
          _transaction.crosschainTx.invariant.sendingChainId,
        ),
      });
      const jsonErr = jsonifyError(err);
      if (safeJsonStringify(jsonErr).includes("#F:019")) {
        logger.warn("Sender already fulfilled", requestContext, methodContext, { error: jsonErr });
      } else {
        logger.error("Error fulfilling sender", requestContext, methodContext, jsonErr, {
          chainId: transaction.crosschainTx.invariant.sendingChainId,
        });
      }
    }
  } else if (transaction.status === CrosschainTransactionStatus.ReceiverExpired) {
    const requestContext = createRequestContext(
      "ContractReader => ReceiverExpired",
      transaction.crosschainTx.invariant.transactionId,
    );
    const _transaction = transaction as ActiveTransaction<"ReceiverExpired">;
    if (!_transaction.payload.hashes?.receiving) {
      logger.warn("No receiving hashes with ReceiverExpired status", requestContext, methodContext, {
        hashes: _transaction.payload.hashes,
      });
      return;
    }
    try {
      logger.info("Cancelling expired receiver", requestContext, methodContext);
      receipt = await cancel(
        _transaction.crosschainTx.invariant,
        {
          amount: _transaction.crosschainTx.receiving!.amount,
          expiry: _transaction.crosschainTx.receiving!.expiry,
          preparedBlockNumber: _transaction.crosschainTx.receiving!.preparedBlockNumber,
          preparedTransactionHash: _transaction.payload.hashes.receiving.prepareHash,
          side: "receiver",
        },
        requestContext,
      );
      logger.info("Cancelled receiver", requestContext, methodContext, {
        txHash: receipt?.transactionHash,
      });
      const receivingAssetName = getAssetName(
        _transaction.crosschainTx.invariant.receivingAssetId,
        _transaction.crosschainTx.invariant.receivingChainId,
      );
      receiverCancelled.inc({
        sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
        sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
        receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
        receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
        assetName: receivingAssetName,
      });
      receiverExpired.inc({
        sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
        sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
        receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
        receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
        assetName: receivingAssetName,
      });
    } catch (err: any) {
      receiverFailedCancel.inc({
        sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
        receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
        sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
        receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
        assetName: getAssetName(
          _transaction.crosschainTx.invariant.receivingAssetId,
          _transaction.crosschainTx.invariant.receivingChainId,
        ),
      });
      const errJson = jsonifyError(err);
      if (safeJsonStringify(errJson).includes("#C:019")) {
        logger.warn("Already cancelled", requestContext, methodContext, { error: errJson });
      } else {
        logger.error("Error cancelling receiver", requestContext, methodContext, errJson, {
          chainId: transaction.crosschainTx.invariant.receivingChainId,
        });
      }
    }
  } else if (transaction.status === CrosschainTransactionStatus.SenderExpired) {
    const requestContext = createRequestContext(
      "ContractReader => SenderExpired",
      transaction.crosschainTx.invariant.transactionId,
    );
    const _transaction = transaction as ActiveTransaction<"SenderExpired">;
    if (!_transaction.payload.hashes.sending) {
      logger.warn("No sending hashes with SenderExpired status", requestContext, methodContext, {
        hashes: _transaction.payload.hashes,
      });
      return;
    }
    try {
      logger.info("Cancelling expired sender", requestContext, methodContext);
      receipt = await cancel(
        _transaction.crosschainTx.invariant,
        {
          amount: _transaction.crosschainTx.sending.amount,
          expiry: _transaction.crosschainTx.sending.expiry,
          preparedBlockNumber: _transaction.crosschainTx.sending.preparedBlockNumber,
          preparedTransactionHash: _transaction.payload.hashes.sending.prepareHash,
          side: "sender",
        },
        requestContext,
      );
      logger.info("Cancelled sender", requestContext, methodContext, { txHash: receipt?.transactionHash });
      const sendingAssetName = getAssetName(
        _transaction.crosschainTx.invariant.sendingAssetId,
        _transaction.crosschainTx.invariant.sendingChainId,
      );
      senderCancelled.inc({
        sendingAssetId: transaction.crosschainTx.invariant.sendingAssetId,
        sendingChainId: transaction.crosschainTx.invariant.sendingChainId,
        receivingAssetId: transaction.crosschainTx.invariant.receivingAssetId,
        receivingChainId: transaction.crosschainTx.invariant.receivingChainId,
        assetName: sendingAssetName,
      });
      senderExpired.inc({
        sendingAssetId: transaction.crosschainTx.invariant.sendingAssetId,
        sendingChainId: transaction.crosschainTx.invariant.sendingChainId,
        receivingAssetId: transaction.crosschainTx.invariant.receivingAssetId,
        receivingChainId: transaction.crosschainTx.invariant.receivingChainId,
        assetName: sendingAssetName,
      });
    } catch (err: any) {
      const errJson = jsonifyError(err);
      if (safeJsonStringify(errJson).includes("#C:019")) {
        logger.warn("Already cancelled", requestContext, methodContext, { error: errJson });
      } else {
        logger.error("Error cancelling sender", requestContext, methodContext, errJson, {
          chainId: transaction.crosschainTx.invariant.sendingChainId,
        });
      }
    }
    // If sender is cancelled, receiver should already be expired. If we do
    // not cancel here that is *ok* because it would have been caught earlier
    // when we cancel the receiving chain side (via enforcement)
  } else if (transaction.status === CrosschainTransactionStatus.ReceiverCancelled) {
    const _transaction = transaction as ActiveTransaction<"ReceiverCancelled">;
    // if receiver is cancelled, cancel the sender as well
    const requestContext = createRequestContext(
      "ContractReader => ReceiverCancelled",
      transaction.crosschainTx.invariant.transactionId,
    );
    if (!_transaction.payload.hashes.sending) {
      logger.warn("No sending hashes with ReceiverCancelled status", requestContext, methodContext, {
        hashes: _transaction.payload.hashes,
      });
      return;
    }
    if (!_transaction.payload.hashes.receiving?.cancelHash) {
      logger.warn("No cancel hash for receiving chain", requestContext, methodContext, {
        hashes: _transaction.payload.hashes,
      });
      return;
    }
    const chainConfig = config.chainConfig[_transaction.crosschainTx.invariant.receivingChainId];
    if (!chainConfig) {
      // this should not happen, this should get checked before this point
      throw new ContractReaderNotAvailableForChain(_transaction.crosschainTx.invariant.receivingChainId, {
        methodContext,
        requestContext,
      });
    }
    const receiverCancelledReceipt = await txService.getTransactionReceipt(
      _transaction.crosschainTx.invariant.receivingChainId,
      _transaction.payload.hashes.receiving.cancelHash,
    );
    if ((receiverCancelledReceipt?.confirmations ?? 0) < chainConfig.confirmations) {
      logger.info("Waiting for safe confirmations", requestContext, methodContext, {
        chainId: _transaction.crosschainTx.invariant.receivingChainId,
        txHash: _transaction.payload.hashes.receiving.cancelHash,
        txConfirmations: receiverCancelledReceipt?.confirmations ?? 0,
        configuredConfirmations: chainConfig.confirmations,
      });
      return;
    }

    try {
      logger.info("Cancelling sender after receiver cancelled", requestContext, methodContext, {
        receiverCancelTransaction: {
          transactionHash: receiverCancelledReceipt.transactionHash,
          block: receiverCancelledReceipt.blockNumber,
          confirmations: receiverCancelledReceipt.confirmations,
        },
      });
      receipt = await cancel(
        _transaction.crosschainTx.invariant,
        {
          amount: _transaction.crosschainTx.sending.amount,
          expiry: _transaction.crosschainTx.sending.expiry,
          preparedBlockNumber: _transaction.crosschainTx.sending.preparedBlockNumber,
          preparedTransactionHash: _transaction.payload.hashes.sending.prepareHash,
          side: "sender",
        },
        requestContext,
      );
      logger.info("Cancelled sender", requestContext, methodContext, { txHash: receipt?.transactionHash });
      const sendingAssetName = getAssetName(
        _transaction.crosschainTx.invariant.sendingAssetId,
        _transaction.crosschainTx.invariant.sendingChainId,
      );
      senderCancelled.inc({
        sendingAssetId: transaction.crosschainTx.invariant.sendingAssetId,
        sendingChainId: transaction.crosschainTx.invariant.sendingChainId,
        receivingAssetId: transaction.crosschainTx.invariant.receivingAssetId,
        receivingChainId: transaction.crosschainTx.invariant.receivingChainId,
        assetName: sendingAssetName,
      });
    } catch (err: any) {
      senderFailedCancel.inc({
        sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
        receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
        sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
        receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
        assetName: getAssetName(
          _transaction.crosschainTx.invariant.sendingAssetId,
          _transaction.crosschainTx.invariant.sendingChainId,
        ),
      });
      const errJson = jsonifyError(err);
      if (safeJsonStringify(errJson).includes("#C:019")) {
        logger.warn("Already cancelled", requestContext, methodContext, { error: errJson });
      } else {
        logger.error("Error cancelling sender", requestContext, methodContext, errJson, {
          chainId: transaction.crosschainTx.invariant.sendingChainId,
        });
      }
    }
  } else if (transaction.status === CrosschainTransactionStatus.ReceiverNotConfigured) {
    const _transaction = transaction as ActiveTransaction<"ReceiverNotConfigured">;
    // if receiver is not configured, cancel the sender
    const requestContext = createRequestContext(
      "ContractReader => ReceiverNotConfigured",
      transaction.crosschainTx.invariant.transactionId,
    );
    if (!_transaction.payload.hashes.sending) {
      logger.warn("No sending hashes with ReceiverNotConfigured status", requestContext, methodContext, {
        hashes: _transaction.payload.hashes,
      });
      return;
    }
    try {
      logger.info("Cancelling sender because receiver is not configured", requestContext, methodContext);
      receipt = await cancel(
        _transaction.crosschainTx.invariant,
        {
          amount: _transaction.crosschainTx.sending.amount,
          expiry: _transaction.crosschainTx.sending.expiry,
          preparedBlockNumber: _transaction.crosschainTx.sending.preparedBlockNumber,
          preparedTransactionHash: _transaction.payload.hashes.sending.prepareHash,
          side: "sender",
        },
        requestContext,
      );
      logger.info("Cancelled sender", requestContext, methodContext, { txHash: receipt?.transactionHash });
      const sendingAssetName = getAssetName(
        _transaction.crosschainTx.invariant.sendingAssetId,
        _transaction.crosschainTx.invariant.sendingChainId,
      );
      senderCancelled.inc({
        sendingAssetId: transaction.crosschainTx.invariant.sendingAssetId,
        sendingChainId: transaction.crosschainTx.invariant.sendingChainId,
        receivingAssetId: transaction.crosschainTx.invariant.receivingAssetId,
        receivingChainId: transaction.crosschainTx.invariant.receivingChainId,
        assetName: sendingAssetName,
      });
    } catch (err: any) {
      senderFailedCancel.inc({
        sendingAssetId: _transaction.crosschainTx.invariant.sendingAssetId,
        receivingAssetId: _transaction.crosschainTx.invariant.receivingAssetId,
        sendingChainId: _transaction.crosschainTx.invariant.sendingChainId,
        receivingChainId: _transaction.crosschainTx.invariant.receivingChainId,
        assetName: getAssetName(
          _transaction.crosschainTx.invariant.sendingAssetId,
          _transaction.crosschainTx.invariant.sendingChainId,
        ),
      });
      const errJson = jsonifyError(err);
      if (safeJsonStringify(errJson).includes("#C:019")) {
        logger.warn("Already cancelled", requestContext, methodContext, { error: errJson });
      } else {
        logger.error("Error cancelling sender", requestContext, methodContext, errJson, {
          chainId: transaction.crosschainTx.invariant.sendingChainId,
        });
      }
    }
  }
  return receipt;
};
