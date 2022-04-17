import { NxtpSdk, NxtpSdkEvents } from "@connext/nxtp-sdk";
import { constants, Contract, providers, utils, Wallet, BigNumber } from "ethers";
import pino from "pino";
import TransactionManagerArtifact from "@connext/nxtp-contracts/artifacts/contracts/TransactionManager.sol/TransactionManager.json";
import { TransactionManager } from "@connext/nxtp-contracts/typechain";
import { AuctionResponse, jsonifyError, expect, Logger } from "@connext/nxtp-utils";

const { AddressZero } = constants;

const TestTokenABI = [
  // Read-Only Functions
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address _owner, address _spender) public view returns (uint256 remaining)",

  // Authenticated Functions
  "function approve(address _spender, uint256 _value) public returns (bool success)",
  "function transfer(address to, uint amount) returns (boolean)",
  "function mint(address account, uint256 amount)",
];

const erc20Address = "0x345cA3e014Aaf5dcA488057592ee47305D9B3e10";

const txManagerAddressSending = "0x8CdaF0CD259887258Bc13a92C0a6dA92698644C0";
const txManagerAddressReceiving = txManagerAddressSending;

const SENDING_CHAIN = 1337;
const SENDING_PROVIDER_URL = "http://localhost:8545";
const RECEIVING_CHAIN = 1338;
const RECEIVING_PROVIDER_URL = "http://localhost:8546";

const sendingChainProvider = new providers.FallbackProvider([
  new providers.StaticJsonRpcProvider(SENDING_PROVIDER_URL, SENDING_CHAIN),
]);
const receivingChainProvider = new providers.FallbackProvider([
  new providers.StaticJsonRpcProvider(RECEIVING_PROVIDER_URL, RECEIVING_CHAIN),
]);

const chainConfig = {
  [SENDING_CHAIN]: {
    providers: [SENDING_PROVIDER_URL],
    transactionManagerAddress: txManagerAddressSending,
    subgraph: "http://localhost:8010/subgraphs/name/connext/nxtp",
  },
  [RECEIVING_CHAIN]: {
    providers: [RECEIVING_PROVIDER_URL],
    transactionManagerAddress: txManagerAddressReceiving,
    subgraph: "http://localhost:9010/subgraphs/name/connext/nxtp",
  },
};

const fundedPk = "0xc87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3";
const router = "0xDc150c5Db2cD1d1d8e505F824aBd90aEF887caC6";

const sugarDaddy = new Wallet(fundedPk);
const MIN_ETH = utils.parseEther("0.5");
const ETH_GIFT = utils.parseEther("1");

const MIN_TOKEN = utils.parseEther("5");
const TOKEN_GIFT = utils.parseEther("10");

const txManagerSending = new Contract(
  txManagerAddressSending,
  TransactionManagerArtifact.abi,
  sugarDaddy.connect(sendingChainProvider),
) as TransactionManager;
const txManagerReceiving = new Contract(
  txManagerAddressReceiving,
  TransactionManagerArtifact.abi,
  sugarDaddy.connect(receivingChainProvider),
) as TransactionManager;

const logger = pino({ name: "IntegrationTest", level: process.env.LOG_LEVEL ?? "error" });

describe("Integration", () => {
  let userSdk: NxtpSdk;
  let userWallet: Wallet;

  const tokenSending = new Contract(erc20Address, TestTokenABI, sugarDaddy.connect(sendingChainProvider));

  const tokenReceiving = new Contract(erc20Address, TestTokenABI, sugarDaddy.connect(receivingChainProvider));

  const setupTest = async (sendingTokenAddress: string, receivingTokenAddress: string): Promise<void> => {
    const tokenAddressSending = sendingTokenAddress;
    const tokenAddressReceiving = receivingTokenAddress;

    const balanceSending = await sendingChainProvider.getBalance(router);
    const balanceReceiving = await receivingChainProvider.getBalance(router);

    // fund if necessary
    if (balanceSending.lt(MIN_ETH)) {
      logger.info({ chainId: SENDING_CHAIN }, "Sending ETH_GIFT to router");
      const tx = await sugarDaddy.connect(sendingChainProvider).sendTransaction({ to: router, value: ETH_GIFT });
      const receipt = await tx.wait(2);
      logger.info({ transactionHash: receipt.transactionHash, chainId: SENDING_CHAIN }, "ETH_GIFT to router mined");
    }

    if (balanceReceiving.lt(MIN_ETH)) {
      logger.info({ chainId: RECEIVING_CHAIN }, "Sending ETH_GIFT to router");
      const tx = await sugarDaddy.connect(receivingChainProvider).sendTransaction({ to: router, value: ETH_GIFT });
      const receipt = await tx.wait(2);
      logger.info({ transactionHash: receipt.transactionHash, chainId: RECEIVING_CHAIN }, "ETH_GIFT to router mined: ");
    }

    const isRouterSending = await txManagerSending.approvedRouters(router);
    const isRouterReceiving = await txManagerReceiving.approvedRouters(router);

    if (!isRouterSending) {
      logger.info({ chainId: SENDING_CHAIN }, "Adding router");
      const tx = await txManagerSending.addRouter(router);
      const receipt = await tx.wait(2);
      logger.info({ transactionHash: receipt.transactionHash, chainId: SENDING_CHAIN }, "Router added");
    }

    if (!isRouterReceiving) {
      logger.info({ chainId: RECEIVING_CHAIN }, "Adding router");
      const tx = await txManagerReceiving.addRouter(router);
      const receipt = await tx.wait(2);
      logger.info({ transactionHash: receipt.transactionHash, chainId: RECEIVING_CHAIN }, "Router added");
    }

    const isAssetSending = await txManagerSending.approvedAssets(tokenAddressSending);
    const isAssetReceiving = await txManagerReceiving.approvedAssets(tokenAddressReceiving);

    if (!isAssetSending) {
      logger.info({ chainId: SENDING_CHAIN }, "Adding Asset");
      const tx = await txManagerSending.addAssetId(tokenAddressSending);
      const receipt = await tx.wait(2);
      logger.info({ transactionHash: receipt.transactionHash, chainId: SENDING_CHAIN }, "Asset added");
    }

    if (!isAssetReceiving) {
      logger.info({ chainId: RECEIVING_CHAIN }, "Adding Asset");
      const tx = await txManagerReceiving.addAssetId(tokenAddressReceiving);
      const receipt = await tx.wait(2);
      logger.info({ transactionHash: receipt.transactionHash, chainId: RECEIVING_CHAIN }, "Asset added");
    }

    const liquiditySending = await txManagerSending.routerBalances(router, tokenAddressSending);
    console.log("liquiditySending: ", liquiditySending.toString());
    const liquidityReceiving = await txManagerReceiving.routerBalances(router, tokenAddressReceiving);
    console.log("liquidityReceiving: ", liquidityReceiving.toString());

    // fund if necessary
    logger.info(
      {
        liquidity: liquiditySending.toString(),
        asset: tokenAddressSending,
        chain: SENDING_CHAIN,
        router,
        transactionManager: txManagerSending.address,
      },
      "Liquidity available",
    );
    if (liquiditySending.lt(MIN_TOKEN)) {
      logger.info({ chainId: SENDING_CHAIN }, "Adding liquidity");
      if (tokenAddressSending !== AddressZero) {
        const approvetx = await tokenSending.approve(txManagerSending.address, constants.MaxUint256);
        const approveReceipt = await approvetx.wait(2);
        logger.info(
          { transactionHash: approveReceipt.transactionHash, chainId: SENDING_CHAIN },
          "addLiquidity approved",
        );
      }
      const tx = await txManagerSending.addLiquidityFor(
        TOKEN_GIFT,
        tokenAddressSending,
        router,
        tokenAddressSending === AddressZero ? { value: BigNumber.from(TOKEN_GIFT) } : {},
      );
      const receipt = await tx.wait(2);

      logger.info({ transactionHash: receipt.transactionHash, chainId: SENDING_CHAIN }, "addLiquidity mined");
    }

    logger.info(
      {
        liquidity: liquidityReceiving.toString(),
        asset: tokenAddressReceiving,
        chain: RECEIVING_CHAIN,
        router,
        transactionManager: txManagerReceiving.address,
      },
      "Liquidity available",
    );
    if (liquidityReceiving.lt(MIN_TOKEN)) {
      logger.info({ chainId: RECEIVING_CHAIN }, "Adding liquidity");
      if (tokenAddressSending !== AddressZero) {
        const approvetx = await tokenReceiving.approve(txManagerReceiving.address, constants.MaxUint256);
        const approveReceipt = await approvetx.wait(2);
        logger.info(
          { transactionHash: approveReceipt.transactionHash, chainId: RECEIVING_CHAIN },
          "addLiquidity approved",
        );
      }
      const tx = await txManagerReceiving.addLiquidityFor(
        TOKEN_GIFT,
        tokenAddressReceiving,
        router,
        tokenAddressReceiving === AddressZero ? { value: BigNumber.from(TOKEN_GIFT) } : {},
      );
      const receipt = await tx.wait(2);

      logger.info({ transactionHash: receipt.transactionHash, chainId: RECEIVING_CHAIN }, "addLiquidity mined");
    }
  };

  const test = async (sendingAssetId: string, receivingAssetId: string, actualAmount?: boolean) => {
    let quote: AuctionResponse;
    try {
      await userSdk.getActiveTransactions();
      quote = await userSdk.getTransferQuote({
        amount: utils.parseEther("1").toString(),
        receivingAssetId,
        sendingAssetId,
        receivingAddress: userWallet.address,
        expiry: Math.floor(Date.now() / 1000) + 3600 * 24 * 3,
        sendingChainId: SENDING_CHAIN,
        receivingChainId: RECEIVING_CHAIN,
      });
    } catch (err) {
      logger.error({ err: jsonifyError(err) }, "Error getting transfer quote");
      throw err;
    }

    expect(quote.bid).to.be.ok;
    expect(quote.bidSignature).to.be.ok;
    const res = await userSdk.prepareTransfer(
      quote!,
      false,
      actualAmount ? BigNumber.from(quote.bid.amount).sub(utils.parseEther("0.1")).toString() : undefined,
    );
    expect(res.prepareResponse.hash).to.be.ok;
    const event = await userSdk.waitFor(
      NxtpSdkEvents.ReceiverTransactionPrepared,
      100_000,
      (data) => data.txData.transactionId === res.transactionId,
    );

    const finishRes = await userSdk.fulfillTransfer(event, true);
    logger.info("fullfill Transfer at receiver side", finishRes);

    expect(finishRes.transactionHash).to.be.ok;
  };

  beforeEach(async () => {
    userWallet = Wallet.createRandom();

    // fund user sender side
    const balanceSending = await sendingChainProvider.getBalance(userWallet.address);
    if (balanceSending.lt(TOKEN_GIFT)) {
      logger.info({ chainId: SENDING_CHAIN }, "Sending ETH_GIFT to user");
      const tx = await sugarDaddy
        .connect(sendingChainProvider)
        .sendTransaction({ to: userWallet.address, value: TOKEN_GIFT });
      const receipt = await tx.wait(2);
      logger.info({ transactionHash: receipt.transactionHash, chainId: SENDING_CHAIN }, "ETH_GIFT to user mined: ");
    }

    const balanceTokenSending = await tokenSending.balanceOf(userWallet.address);
    if (balanceTokenSending.lt(MIN_TOKEN)) {
      logger.info({ chainId: SENDING_CHAIN }, "Sending TOKEN_GIFT to user");
      const tx = await tokenSending.mint(userWallet.address, TOKEN_GIFT);
      const receipt = await tx.wait(2);
      logger.info({ transactionHash: receipt.transactionHash, chainId: SENDING_CHAIN }, "TOKEN_GIFT to user mined: ");
    }

    userSdk = new NxtpSdk({
      chainConfig,
      signer: userWallet.connect(sendingChainProvider),
      logger: new Logger({ name: "IntegrationTest", level: process.env.LOG_LEVEL ?? "debug" }),
      network: "local",
    });
  });

  it.only("should send ERC20 tokens", async function () {
    this.timeout(120_000);

    const sendingAssetId = erc20Address;
    const receivingAssetId = erc20Address;

    await setupTest(sendingAssetId, receivingAssetId);

    await test(sendingAssetId, receivingAssetId);
  });

  it("should send Native tokens", async function () {
    this.timeout(120_000);

    const sendingAssetId = AddressZero;
    const receivingAssetId = AddressZero;

    await setupTest(sendingAssetId, receivingAssetId);

    await test(sendingAssetId, receivingAssetId);
  });
});
