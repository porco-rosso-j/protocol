import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expect } from 'chai'
import { BigNumber, ContractFactory, Wallet } from 'ethers'
import hre, { ethers, waffle } from 'hardhat'
import { IMPLEMENTATION } from '../../fixtures'
import { defaultFixture, ORACLE_TIMEOUT } from './fixtures'
import { getChainId } from '../../../common/blockchain-utils'
import {
  IGovParams,
  IRTokenSetup,
  networkConfig,
} from '../../../common/configuration'
import { CollateralStatus, MAX_UINT256, ZERO_ADDRESS } from '../../../common/constants'
import { expectEvents, expectInIndirectReceipt } from '../../../common/events'
import { bn, fp, toBNDecimals, ZERO } from '../../../common/numbers'
import { whileImpersonating } from '../../utils/impersonation'
import { getOraclePrice, setOraclePrice1 } from '../../utils/oracles'
import { advanceBlocks, advanceTime, getLatestBlockTimestamp } from '../../utils/time'
import {
  Asset,
  EULClaimableETokenWSTETHCollateral,
  EulDistributorMock,
  ETokenMock,
  ERC20Mock,
  FacadeRead,
  FacadeTest,
  FacadeWrite,
  IAssetRegistry,
  IBasketHandler,
  InvalidMockV3Aggregator,
  OracleLib,
  MockV3Aggregator,
  RTokenAsset,
  TestIBackingManager,
  TestIDeployer,
  TestIMain,
  TestIRToken
} from '../../../typechain'
import { 
  ITestParams, 
  eTokenHolders, 
  targetName, 
  etokenRefPerTok, 
  delta, 
  issueAmount, 
  tokenOneUnit, 
  fallBackPrice,
  config,
  rTokenConfig,
  BN1,
  FP1
} from './test-params'

const createFixtureLoader = waffle.createFixtureLoader
const describeFork = process.env.FORK ? describe : describe.skip

describeFork(`EULClaimableETokenWSTETHCollateral - Mainnet Forking P${IMPLEMENTATION}`, function () {

  let params: ITestParams

  let owner: SignerWithAddress
  let addr1: SignerWithAddress

  // Tokens/Assets
  let token: ERC20Mock
  let eToken: ETokenMock
  let eTokenCollateral: EULClaimableETokenWSTETHCollateral
  let eulToken: ERC20Mock
  let eulAsset: Asset
  let rsr: ERC20Mock
  let rsrAsset: Asset

  // Core Contracts
  let main: TestIMain
  let rToken: TestIRToken
  let rTokenAsset: RTokenAsset
  let assetRegistry: IAssetRegistry
  let backingManager: TestIBackingManager
  let basketHandler: IBasketHandler

  let deployer: TestIDeployer
  let facade: FacadeRead
  let facadeTest: FacadeTest
  let facadeWrite: FacadeWrite
  let oracleLib: OracleLib
  let govParams: IGovParams

  const defaultThreshold = fp('0.05') // 5%
  const delayUntilDefault = bn('86400') // 24h

  let loadFixture: ReturnType<typeof createFixtureLoader>
  let wallet: Wallet
  let chainId: number
  
  let ETokenCollateralFactory: ContractFactory
  let MockV3AggregatorFactory: ContractFactory
  let mockChainlinkFeed: MockV3Aggregator

  let EulDistributorMockFactory: ContractFactory
  let euldistributor: EulDistributorMock

  before(async () => {
    ;[wallet] = (await ethers.getSigners()) as unknown as Wallet[]
    loadFixture = createFixtureLoader([wallet])

    chainId = await getChainId(hre)
    if (!networkConfig[chainId]) {
      throw new Error(`Missing network configuration for ${hre.network.name}`)
    }
  })

  beforeEach(async () => {
    ;[owner, addr1] = await ethers.getSigners()
    ;({ rsr, rsrAsset, deployer, facade, facadeTest, facadeWrite, oracleLib, govParams } =
      await loadFixture(defaultFixture))

    // ---  Testing Params ---- //
    // Define which SelfReferentialCollateral, such as WETH, UNI, LINK is used for this test file. 
    
    params = {
        // Token Addresses
        eulAddr: networkConfig[chainId].tokens.EUL,
        tokenAddr: networkConfig[chainId].tokens.WSTETH,
        etokenAddr: networkConfig[chainId].tokens.eWSTETH,
        // ChainlinkFeed
        tokenChainlinkFeed: networkConfig[chainId].chainlinkFeeds.STETH,
        refUnitChainlinkFeed: ZERO_ADDRESS,
        targetChainlinkFeed: networkConfig[chainId].chainlinkFeeds.ETH,
        // Holder address in Mainnet
        etokenHolderAddr: eTokenHolders.ewsteth,
        // Target
        targetName: targetName.eth,
        // Numbers: 
        refPerTok: etokenRefPerTok.ewsteth, 
        refPerTok1: etokenRefPerTok.ewsteth1,
        delta: delta.wsteth, 
        issueAmount: issueAmount.wsteth, 
        oneUnit: tokenOneUnit.erc18, 
        fallBackPrice: fallBackPrice.wsteth
      }
    
    // ------- // 

    // Get required contracts for eDAI
    // EUL token
    eulToken = <ERC20Mock>(
      await ethers.getContractAt('ERC20Mock', params.eulAddr || '')
    )
    // DAI token
    token = <ERC20Mock>(
      await ethers.getContractAt('ERC20Mock', params.tokenAddr || '')
    )
    // eToken token
    eToken = <ETokenMock>(
      await ethers.getContractAt('ETokenMock', params.etokenAddr || '')
    )

    eulAsset = <Asset>(
      await (
        await ethers.getContractFactory('Asset')
      ).deploy(
        fp('1'),
        // networkConfig[chainId].chainlinkFeeds.EUL || '', // COMP Feed due to lack of EUL chainlink feed
        networkConfig[chainId].chainlinkFeeds.EUL as string, // COMP Feed due to lack of EUL chainlink feed
        eulToken.address,
        config.rTokenMaxTradeVolume,
        ORACLE_TIMEOUT
      )
    )

    // Deploy EulDistributorMock
    EulDistributorMockFactory = await ethers.getContractFactory('EulDistributorMock')
    euldistributor = <EulDistributorMock>await EulDistributorMockFactory.deploy(eulToken.address)

    // Deploy eToken collateral plugin
    ETokenCollateralFactory = await ethers.getContractFactory('EULClaimableETokenWSTETHCollateral', {
      libraries: { OracleLib: oracleLib.address },
    })
    eTokenCollateral = <EULClaimableETokenWSTETHCollateral>(
      await ETokenCollateralFactory.deploy(
        params.fallBackPrice, // {UoA}
        params.tokenChainlinkFeed as string,
        params.targetChainlinkFeed as string,
        params.etokenAddr as string,
        config.rTokenMaxTradeVolume,
        ORACLE_TIMEOUT,
        params.targetName,
        defaultThreshold,
        delayUntilDefault,
        (await token.decimals()).toString(),
        params.tokenAddr as string,
        euldistributor.address
      )
    )

    // Setup balances for addr1 - Transfer from Mainnet holder
    // eToken
    await whileImpersonating(params.etokenHolderAddr, async (etokenSigner) => {
      await eToken.connect(etokenSigner).transfer(addr1.address, toBNDecimals(params.issueAmount, 18))
    })

    // Set primary basket
    const rTokenSetup: IRTokenSetup = {
      assets: [eulAsset.address],
      primaryBasket: [eTokenCollateral.address],
      weights: [fp('1')],
      backups: [],
      beneficiaries: []
    }

    // Deploy RToken via FacadeWrite
    const receipt = await (
      await facadeWrite.connect(owner).deployRToken(rTokenConfig, rTokenSetup)
    ).wait()

    // Get Main
    const mainAddr = expectInIndirectReceipt(receipt, deployer.interface, 'RTokenCreated').args.main
    main = <TestIMain>await ethers.getContractAt('TestIMain', mainAddr)

    // Get core contracts
    assetRegistry = <IAssetRegistry>(
      await ethers.getContractAt('IAssetRegistry', await main.assetRegistry())
    )
    backingManager = <TestIBackingManager>(
      await ethers.getContractAt('TestIBackingManager', await main.backingManager())
    )
    basketHandler = <IBasketHandler>(
      await ethers.getContractAt('IBasketHandler', await main.basketHandler())
    )
    rToken = <TestIRToken>await ethers.getContractAt('TestIRToken', await main.rToken())
    rTokenAsset = <RTokenAsset>(
      await ethers.getContractAt('RTokenAsset', await assetRegistry.toAsset(rToken.address))
    )

    // Setup owner and unpause
    await facadeWrite.connect(owner).setupGovernance(
      rToken.address,
      false, // do not deploy governance
      true, // unpaused
      govParams, // mock values, not relevant
      owner.address, // owner
      ZERO_ADDRESS, // no guardian
      ZERO_ADDRESS // no pauser
    )

    // Setup mock chainlink feed for some of the tests (so we can change the value)
    MockV3AggregatorFactory = await ethers.getContractFactory('MockV3Aggregator')
    mockChainlinkFeed = <MockV3Aggregator>await MockV3AggregatorFactory.deploy(await token.decimals(), params.oneUnit)
  })

  describe('Deployment', () => {

    // Check the initial state
    it('Should setup RToken, Assets, and Collateral correctly', async () => {

      expect(await eulAsset.isCollateral()).to.equal(false)
      expect(await eulAsset.erc20()).to.equal(eulToken.address)
      expect(await eulAsset.erc20()).to.equal(networkConfig[chainId].tokens.EUL)
      // expect(await eulAsset.strictPrice()).to.be.closeTo(fp('58'), fp('0.5')) // No Chainlink Address for EUL
      await expect(eulAsset.claimRewards()).to.not.emit(eulAsset, 'RewardsClaimed')
      expect(await eulAsset.maxTradeVolume()).to.equal(config.rTokenMaxTradeVolume)

      expect(await eulToken.decimals()).to.equal(18)
      expect(await eToken.decimals()).to.equal(18)

      // Check Collateral plugin
      // eToken (EULClaimableETokenWSTETHCollateral)

      const wstETHPrice:BigNumber = await eTokenCollateral.getWstETHPrice()
      const stETHPrice:BigNumber = await eTokenCollateral.getStETHPrice()
      const ETHPrice:BigNumber = await eTokenCollateral.getETHPrice()

      const strictPrice:BigNumber = await eTokenCollateral.strictPrice()
      const refPerTok:BigNumber = await eTokenCollateral.refPerTok()
      const targetPerUnderlying:BigNumber = await eTokenCollateral.getTargetPerUnderlying()

      expect(await eTokenCollateral.fallbackPrice()).to.equal(params.fallBackPrice)
      expect(await eTokenCollateral.chainlinkFeed()).to.equal(params.tokenChainlinkFeed as string)
      expect(await eTokenCollateral.targetChainlinkFeed()).to.equal(params.targetChainlinkFeed as string)
      expect(await eTokenCollateral.erc20()).to.equal(params.etokenAddr as string)
      expect(await eTokenCollateral.targetName()).to.equal(params.targetName)

      expect(await eTokenCollateral.isCollateral()).to.equal(true)
      expect(await eTokenCollateral.referenceERC20Decimals()).to.equal(await token.decimals())
      expect(await eTokenCollateral.targetPerRef()).to.equal(wstETHPrice.mul(BN1).div(ETHPrice))
      expect(await eTokenCollateral.prevReferencePrice()).to.be.closeTo(params.refPerTok, params.delta)
    
      expect(wstETHPrice).to.be.closeTo(params.fallBackPrice, params.delta)
      expect(stETHPrice).to.be.closeTo( await getOraclePrice(params.tokenChainlinkFeed as string, owner), params.delta)
      expect(ETHPrice).to.be.closeTo( await getOraclePrice(params.targetChainlinkFeed as string, owner), params.delta)
      expect(strictPrice).to.be.closeTo(params.refPerTok.mul(params.fallBackPrice).div(BN1), params.delta)
      expect(refPerTok).to.be.closeTo(params.refPerTok, params.delta)
      expect(targetPerUnderlying).to.be.closeTo(ETHPrice.mul(BN1).div(wstETHPrice), params.delta)

      // Check claim data
      await expect(eTokenCollateral.claimRewards())
        .to.emit(eTokenCollateral, 'RewardsClaimed')
        .withArgs(eulToken.address, 0)
      expect(await eTokenCollateral.maxTradeVolume()).to.equal(config.rTokenMaxTradeVolume)

      // Should setup contracts
      expect(main.address).to.not.equal(ZERO_ADDRESS)

    console.log(
        '\n',
        '- wstETH Price: ', wstETHPrice.toString(),  '\n',
        '- stETH Price: ', stETHPrice.toString(), '\n',
        '- ETH Price : ', ETHPrice.toString(), '\n',
        '- Collateral Price: ', strictPrice.toString(), '\n',
        '- refPerTok: ', refPerTok.toString(), '\n',
        '- targetPerUnderlying: ', targetPerUnderlying.toString(), '\n',
        '\n',
        )
      })

    // Check assets/collaterals in the Asset Registry
    it('Should register ERC20s and Assets/Collateral correctly', async () => {

      // Check assets/collateral
      const ERC20s = await assetRegistry.erc20s()
      expect(ERC20s[0]).to.equal(rToken.address)
      expect(ERC20s[1]).to.equal(rsr.address)
      expect(ERC20s[2]).to.equal(eulToken.address)
      expect(ERC20s[3]).to.equal(params.etokenAddr as string)
      expect(ERC20s.length).to.eql(4)

      // Assets
      expect(await assetRegistry.toAsset(ERC20s[0])).to.equal(rTokenAsset.address)
      expect(await assetRegistry.toAsset(ERC20s[1])).to.equal(rsrAsset.address)
      expect(await assetRegistry.toAsset(ERC20s[2])).to.equal(eulAsset.address)
      expect(await assetRegistry.toAsset(ERC20s[3])).to.equal(eTokenCollateral.address)

      // Collaterals
      expect(await assetRegistry.toColl(ERC20s[3])).to.equal(eTokenCollateral.address)

      console.log(
        '\n',
        '- RToken Address: ', rToken.address, '\n',
        '- RToken Asset Address:' , rTokenAsset.address, '\n',
        '- EUL Address:' , eulToken.address, '\n',
        '- EulAsset Address:' , eulAsset.address, '\n',
        '- EToken Collateral Address: ', eTokenCollateral.address, '\n',
        '\n',
        )

    })

    // Check RToken basket
    it('Should register Basket correctly', async () => {
      // Basket
      expect(await basketHandler.fullyCollateralized()).to.equal(true)
      const backing = await facade.basketTokens(rToken.address)
      expect(backing[0]).to.equal(params.etokenAddr as string)
      expect(backing.length).to.equal(1)

      // Check other values
      expect(await basketHandler.nonce()).to.be.gt(ZERO)
      expect(await basketHandler.timestamp()).to.be.gt(ZERO)
      expect(await basketHandler.status()).to.equal(CollateralStatus.SOUND)
      expect(await facadeTest.callStatic.totalAssetValue(rToken.address)).to.equal(ZERO)

      const [isFallback, price1] = await basketHandler.price(true)
      expect(isFallback).to.equal(false)
      // 1RToken = ref * (ref/target)
      const rTokenPrice: BigNumber = params.fallBackPrice.mul(
        (await getOraclePrice(params.targetChainlinkFeed as string, owner)).mul(BN1)
        .div(params.fallBackPrice)).div(BN1)

      expect(price1).to.be.closeTo(rTokenPrice ,params.fallBackPrice.mul(fp('0.01')).div(FP1))
      
      // Check RToken price
      await eToken.connect(addr1).approve(rToken.address, toBNDecimals(params.issueAmount, 18).mul(100))
      await expect(rToken.connect(addr1).issue(params.issueAmount)).to.emit(rToken, 'Issuance')

      const price2 :BigNumber = await rTokenAsset.strictPrice()
      expect(price2).to.be.closeTo(rTokenPrice, params.fallBackPrice.mul(fp('0.01')).div(FP1))

      const balanceAddr1ewstETH: BigNumber = await eToken.balanceOf(addr1.address)
      const balanceBackingManagerewstETH: BigNumber = await eToken.balanceOf(backingManager.address)

      // make sure that the smaller unit of eToken is held in backingManager after the issuance of RTokens
      // 1 BU <= 1 Ref
      await expect(params.issueAmount).to.be.gt(balanceBackingManagerewstETH)

      const price3 :BigNumber = await eTokenCollateral.strictPrice()
      const price4:[boolean, BigNumber] = await eTokenCollateral.price(true)

      console.log(
        '\n',
        '- RToken Price(basketHandler): ', price1.toString(), '\n',
        '- RToken Price(rTokenAsset): ', price2.toString(), '\n',
        '- ewstETH Balance Addr1: ', balanceAddr1ewstETH.toString(), '\n',
        '- ewstETH Balance BackingManager: ', balanceBackingManagerewstETH.toString(), '\n',
        '- Collateral strictPrice(eTokenCollateral): ', price3.toString(), '\n',
        '- Collateral price(eTokenCollateral): ', price4[1].toString(), '\n',
        '\n',
      )
    })

    // Validate constructor arguments
    // Note: Adapt it to your plugin constructor validations
    it('Should validate constructor arguments correctly', async () => {

      // Default threshold
      await expect(
        ETokenCollateralFactory.deploy(
          params.fallBackPrice,
          params.tokenChainlinkFeed as string,
          params.targetChainlinkFeed as string,
          params.etokenAddr as string,
          config.rTokenMaxTradeVolume,
          ORACLE_TIMEOUT,
          params.targetName,
          ZERO,
          delayUntilDefault,
          (await token.decimals()).toString(),
          params.tokenAddr as string,
          euldistributor.address
        )
      ).to.be.revertedWith('defaultThreshold zero')

      // ReferemceERC20Decimals
      await expect(
        ETokenCollateralFactory.deploy(
          params.fallBackPrice,
          params.tokenChainlinkFeed as string,
          params.targetChainlinkFeed as string,
          params.etokenAddr as string,
          config.rTokenMaxTradeVolume,
          ORACLE_TIMEOUT,
          params.targetName,
          defaultThreshold,
          delayUntilDefault,
          0,
          params.tokenAddr as string,
          euldistributor.address
        )
      ).to.be.revertedWith('referenceERC20Decimals missing')

      // targetUnitChainlinkFeed
      await expect(
        ETokenCollateralFactory.deploy(
          params.fallBackPrice,
          params.tokenChainlinkFeed as string,
          ZERO_ADDRESS,
          params.etokenAddr as string,
          config.rTokenMaxTradeVolume,
          ORACLE_TIMEOUT,
          params.targetName,
          defaultThreshold,
          delayUntilDefault,
          (await token.decimals()).toString(),
          params.tokenAddr as string,
          euldistributor.address
        )
      ).to.be.revertedWith('targetChainlinkFeed missing')

      // wstETH Address
      await expect(
        ETokenCollateralFactory.deploy(
          params.fallBackPrice,
          params.tokenChainlinkFeed as string,
          params.targetChainlinkFeed as string,
          params.etokenAddr as string,
          config.rTokenMaxTradeVolume,
          ORACLE_TIMEOUT,
          params.targetName,
          defaultThreshold,
          delayUntilDefault,
          (await token.decimals()).toString(),
          ZERO_ADDRESS,
          euldistributor.address
        )
      ).to.be.revertedWith('wstETH missing')

        // eulDistributor Address
        await expect(
          ETokenCollateralFactory.deploy(
            params.fallBackPrice,
            params.tokenChainlinkFeed as string,
            params.targetChainlinkFeed as string,
            params.etokenAddr as string,
            config.rTokenMaxTradeVolume,
            ORACLE_TIMEOUT,
            params.targetName,
            defaultThreshold,
            delayUntilDefault,
            (await token.decimals()).toString(),
            params.tokenAddr as string,
            ZERO_ADDRESS
          )
        ).to.be.revertedWith('eulDistributor missing')
    })
  })

  describe('Issuance/Appreciation/Redemption', () => {

    // Issuance and redemption, making the collateral appreciate over time
    it('Should issue, redeem, and handle appreciation rates correctly', async () => {

      // Store Balances after issuance
      const balanceAddr1eToken1: BigNumber = await eToken.balanceOf(addr1.address)
      const rate1: BigNumber = await eToken.convertBalanceToUnderlying(BN1)

      // Provide approvals for issuances
      await eToken.connect(addr1).approve(rToken.address, toBNDecimals(params.issueAmount, 18).mul(100))

      // Issue rTokens
      await expect(rToken.connect(addr1).issue(params.issueAmount)).to.emit(rToken, 'Issuance')

      // Check RTokens issued to user
      expect(await rToken.balanceOf(addr1.address)).to.equal(params.issueAmount)

      // Check rates and prices
      const eTokenPrice1: BigNumber = await eTokenCollateral.strictPrice() 
      const eTokenRefPerTok1: BigNumber = await eTokenCollateral.refPerTok() 

      const strictPrice: BigNumber = params.fallBackPrice.mul(params.refPerTok).div(BN1)

      expect(eTokenPrice1).to.be.closeTo(strictPrice, params.delta)
      expect(eTokenRefPerTok1).to.be.closeTo(params.refPerTok, params.delta)

      // Check total asset value
      const totalAssetValue1: BigNumber = await facadeTest.callStatic.totalAssetValue(
        rToken.address
      )

      // estimateValue = issue amount * rToken Price(= ref * (target / ref))
      const rTokenPrice: BigNumber = params.fallBackPrice.mul(
        (await getOraclePrice(params.targetChainlinkFeed as string, owner)).mul(BN1)
        .div(params.fallBackPrice)).div(BN1)
      const estimatedValue1: BigNumber = params.issueAmount.div(BN1).mul(rTokenPrice)
      expect(totalAssetValue1).to.be.closeTo(estimatedValue1, params.delta.mul(estimatedValue1.div(BN1))) 

      // Advance time and blocks slightly, causing refPerTok() to increase
      await advanceTime(10000)
      await advanceBlocks(10000)

      // Refresh cToken manually (required)
      await eTokenCollateral.refresh()
      expect(await eTokenCollateral.status()).to.equal(CollateralStatus.SOUND)

      // Check rates and prices - Have changed, slight inrease
      const eTokenPrice2: BigNumber = await eTokenCollateral.strictPrice() // ~1016
      const eTokenRefPerTok2: BigNumber = await eTokenCollateral.refPerTok() // ~1016

      // Check rates and price increase
      expect(eTokenPrice2).to.be.gt(eTokenPrice1)
      expect(eTokenRefPerTok2).to.be.gt(eTokenRefPerTok1)

      // Still close to the original values
      expect(eTokenPrice2).to.be.closeTo(strictPrice, params.delta)
      expect(eTokenRefPerTok2).to.be.closeTo(params.refPerTok, params.delta)

      // Check total asset value increased
      const totalAssetValue2: BigNumber = await facadeTest.callStatic.totalAssetValue(
        rToken.address
      )

      expect(totalAssetValue2).to.be.gt(totalAssetValue1)

      // Advance time and blocks significantly, causing refPerTok() to increase
      await advanceTime(100000000)
      await advanceBlocks(100000000)

      // Refresh cToken manually (required)
      await eTokenCollateral.refresh()
      expect(await eTokenCollateral.status()).to.equal(CollateralStatus.SOUND)

      // Check rates and prices - Have changed significantly
      const eTokenPrice3: BigNumber = await eTokenCollateral.strictPrice() 
      const eTokenRefPerTok3: BigNumber = await eTokenCollateral.refPerTok() 

      // Check rates and price increase
      expect(eTokenPrice3).to.be.gt(eTokenPrice2)
      expect(eTokenRefPerTok3).to.be.gt(eTokenRefPerTok2)

      const strictPrice2: BigNumber = params.fallBackPrice.mul(params.refPerTok1).div(BN1)

      // Need to adjust ranges
      expect(eTokenPrice3).to.be.closeTo(strictPrice2, params.delta)
      expect(eTokenRefPerTok3).to.be.closeTo(params.refPerTok1, params.delta)

      // Check total asset value increased
      const totalAssetValue3: BigNumber = await facadeTest.callStatic.totalAssetValue(
        rToken.address
      )
      expect(totalAssetValue3).to.be.gt(totalAssetValue2)

      // Redeem Rtokens with the updated rates
      await expect(rToken.connect(addr1).redeem(params.issueAmount)).to.emit(rToken, 'Redemption')

      // Check funds were transferred
      expect(await rToken.balanceOf(addr1.address)).to.equal(ZERO)
      expect(await rToken.totalSupply()).to.equal(ZERO)

      // Check balances - Fewer eTokens should have been sent to the user
      const balanceAddr1eToken2: BigNumber = await eToken.balanceOf(addr1.address)
      expect(balanceAddr1eToken2).to.be.lt(balanceAddr1eToken1)

      // Check new etoken balance is worth than previous balance
      const BeforeBalanceValue: BigNumber = rate1.mul(balanceAddr1eToken1).div(params.oneUnit).mul(params.fallBackPrice.div(BN1))
      const AfterBalanceValue: BigNumber = (await eToken.convertBalanceToUnderlying(BN1)).mul(balanceAddr1eToken2).div(params.oneUnit).mul(params.fallBackPrice.div(BN1))
      expect(AfterBalanceValue).to.be.gt(BeforeBalanceValue)

      // Check remainders in Backing Manager
      const BMETokenBalance:BigNumber = await eToken.balanceOf(backingManager.address)
      expect(BMETokenBalance).to.be.gt(ZERO) 

      //  Check total asset value (remainder)
      const RTokenTotalValue: BigNumber = await facadeTest.callStatic.totalAssetValue(rToken.address)
      expect(RTokenTotalValue).to.be.gt(ZERO)

    console.log(
        '\n',
        '- ewstETH Balance 1: ', balanceAddr1eToken1.toString(), '\n',
        '- eTokenRefPerTok1: ', eTokenRefPerTok1.toString(), '\n',
        '- eTokenPrice1: ', eTokenPrice1.toString(), '\n',
        '- totalAssetValue1: ', totalAssetValue1.toString(), '\n',
        '\n',
        '- ewstETH Balance 2: ', balanceAddr1eToken2.toString(), '\n',
        '- eTokenRefPerTok3: ', eTokenRefPerTok3.toString(), '\n',
        '- eTokenPrice3: ', eTokenPrice3.toString(), '\n',
        '- totalAssetValue3: ', totalAssetValue3.toString(), '\n',
        '\n',
        '- BeforeBalanceValue: ', BeforeBalanceValue.toString(), '\n',
        '- AfterBalanceValue: ', AfterBalanceValue.toString(), '\n',
        '- EToken Balance(Backing Manager): ', (BMETokenBalance.div(BN1)).toString(), '\n',
        '- RToken TotalValue: ', (RTokenTotalValue.div(BN1)).toString(), '\n',
        '\n',
        )
    })
  })

  // Note: Even if the collateral does not provide reward tokens, this test should be performed to check that
  // claiming calls throughout the protocol are handled correctly and do not revert.
  describe('Rewards', () => {
    it('Should be able to claim rewards (if applicable)', async () => {

      // Try to claim rewards at this point - Nothing for Backing Manager
      expect(await eulToken.balanceOf(backingManager.address)).to.equal(ZERO)

      await expectEvents(backingManager.claimRewards(), [
        {
          contract: backingManager,
          name: 'RewardsClaimed',
          args: [eulToken.address, bn(ZERO)],
          emitted: true,
        },
      ])

      // No rewards so far
      expect(await eulToken.balanceOf(backingManager.address)).to.equal(ZERO)

      // Provide approvals for issuances
      await eToken.connect(addr1).approve(rToken.address, toBNDecimals(params.issueAmount, 18).mul(100))

      // Issue rTokens
      await expect(rToken.connect(addr1).issue(params.issueAmount)).to.emit(rToken, 'Issuance')

      // Check RTokens issued to user
      expect(await rToken.balanceOf(addr1.address)).to.equal(params.issueAmount)

      // Now we can claim rewards - check initial balance still 0
      expect(await eulToken.balanceOf(backingManager.address)).to.equal(ZERO)

      // Advance Time
      await advanceTime(8000)

      const eulHolder = "0x7597851F3fD386a13b5784677AE8a569bdB33A95"
      await whileImpersonating(eulHolder, async (eulSigner) => {
        await eulToken.connect(eulSigner).transfer(euldistributor.address, toBNDecimals(bn('10000e18'), 18))
      })

      const proof:string[] = ['0x05416460deb76d57af601be17e777b93592d8d4d4a4096c57876a91c84f4a712']
      const claimable: BigNumber = bn('1000e18')
      // console.log("latestClaimDataCount1: ",  await euld.latestClaimDataCount())
      await euldistributor.setClaimData(claimable, proof)

      const result:any = await euldistributor.getClaimData()

      // 1: Claim rewards from Backing Manager
      await expect(backingManager.claimRewards()).to.emit(backingManager, 'RewardsClaimed')

      // Check rewards in EUL
      const rewardsEUL1: BigNumber = await eulToken.balanceOf(backingManager.address)

      expect(rewardsEUL1).to.equal(claimable)

      // Keep moving time
      await advanceTime(3600)

      const claimable2: BigNumber = bn('3000e18')
      await euldistributor.setClaimData(claimable2, proof)

      // 2: Get additional rewards from RToken
      await expect(rToken.claimRewards()).to.emit(rToken, 'RewardsClaimed')

      const rewardsEUL2: BigNumber = await eulToken.balanceOf(rToken.address)

      expect(rewardsEUL2).to.equal(claimable2)

      // Keep moving time
      await advanceTime(2000)

      // 3: Grab final rewards from Revenue Trader
      await rToken.sweepRewardsSingle(eulToken.address)

      const totalReward: BigNumber = await eulToken.balanceOf(backingManager.address)
      const euldistributorBalance: BigNumber = await eulToken.balanceOf(euldistributor.address)

      expect(totalReward).to.equal((bn('10000e18').sub(euldistributorBalance)))

      console.log(
        '\n',
        '- rewardsEUL1: ', rewardsEUL1.toString(), '\n',
        '- rewardsEUL2: ', rewardsEUL2.toString(), '\n',
        '- totalReward: ', totalReward.toString(), '\n',
        '- euldistributorBalance: ', euldistributorBalance.toString(), '\n',
        '\n',
        )
    })
  })

  describe('Price Handling', () => {
    it('Should handle invalid/stale Price', async () => {

      const NO_PRICE_DATA_FEED = '0xAB256C9d6aAE9ee6118A1531d43751996541799D'
      const strictPrice: BigNumber = params.fallBackPrice.mul(params.refPerTok).div(BN1)

      // Non/Invalid Price FEED
      // 1: NO_PRICE_DATA_FEED for tokenChainlinkFeed: USD/stETH
      // 2: NO_PRICE_DATA_FEED for targetChainlinkFeed: USD/ETH
      // 3: Invalid Feed for tokenChainlinkFeed
      // 3: Invalid Feed for targetChainlinkFeed

      // 1: ETokens Collateral with no Underlying(stETH) Price
      const nonUnderlyingEtokenCollateral: EULClaimableETokenWSTETHCollateral = <EULClaimableETokenWSTETHCollateral>await (
        await ethers.getContractFactory('EULClaimableETokenWSTETHCollateral', {
          libraries: { OracleLib: oracleLib.address },
        })
      ).deploy(
        params.fallBackPrice,
        NO_PRICE_DATA_FEED,
        params.targetChainlinkFeed as string,
        params.etokenAddr as string,
        config.rTokenMaxTradeVolume,
        ORACLE_TIMEOUT,
        params.targetName,
        defaultThreshold,
        delayUntilDefault,
        await token.decimals(),
        params.tokenAddr as string,
        euldistributor.address
      )

      // ETokens - Collateral with no underlying price info should revert
      await expect(nonUnderlyingEtokenCollateral.strictPrice()).to.be.reverted

      // Refresh should also revert - status is not modified
      await expect(nonUnderlyingEtokenCollateral.refresh()).to.be.reverted
      const status1 = await nonUnderlyingEtokenCollateral.status()
      expect(status1).to.equal(CollateralStatus.SOUND)

      // 2: ETokens Collateral with no Target(ETH) Price
      const nonTargetPriceEtokenCollateral: EULClaimableETokenWSTETHCollateral = <EULClaimableETokenWSTETHCollateral>await (
        await ethers.getContractFactory('EULClaimableETokenWSTETHCollateral', {
          libraries: { OracleLib: oracleLib.address },
        })
      ).deploy(
        params.fallBackPrice,
        params.tokenChainlinkFeed as string,
        NO_PRICE_DATA_FEED,
        params.etokenAddr as string,
        config.rTokenMaxTradeVolume,
        ORACLE_TIMEOUT,
        params.targetName,
        defaultThreshold,
        delayUntilDefault,
        await token.decimals(),
        params.tokenAddr as string,
        euldistributor.address
      )

      // ETokens - Collateral shouldn't revert even if no target price info is given
      expect(await nonTargetPriceEtokenCollateral.strictPrice()).to.be.closeTo(strictPrice, params.delta) 

      // But refresh should revert - status is not modified
      await expect(nonTargetPriceEtokenCollateral.refresh()).to.be.reverted

      const status2 = await nonTargetPriceEtokenCollateral.status()
      expect(await status2).to.equal(CollateralStatus.SOUND)

      // 3: Reverts with a feed with zero price
      const invalidpriceEtokenCollateral: EULClaimableETokenWSTETHCollateral = <EULClaimableETokenWSTETHCollateral>await (
        await ethers.getContractFactory('EULClaimableETokenWSTETHCollateral', {
          libraries: { OracleLib: oracleLib.address },
        })
      ).deploy(
        params.fallBackPrice,
        mockChainlinkFeed.address,
        params.targetChainlinkFeed as string,
        params.etokenAddr as string,
        config.rTokenMaxTradeVolume,
        ORACLE_TIMEOUT,
        params.targetName,
        defaultThreshold,
        delayUntilDefault,
        await token.decimals(),
        params.tokenAddr as string,
        euldistributor.address
      )

      await setOraclePrice1(mockChainlinkFeed.address, ZERO)

      // Reverts with zero price
      await expect(invalidpriceEtokenCollateral.strictPrice()).to.be.revertedWith(
        'PriceOutsideRange()'
      )
      // Refresh should mark status IFFY
      await invalidpriceEtokenCollateral.refresh()

      const status3 = await invalidpriceEtokenCollateral.status()
      expect(status3).to.equal(CollateralStatus.IFFY)

      // 4: Reverts with a feed with zero price
      const invalidTargetPriceEtokenCollateral: EULClaimableETokenWSTETHCollateral = <EULClaimableETokenWSTETHCollateral>await (
        await ethers.getContractFactory('EULClaimableETokenWSTETHCollateral', {
          libraries: { OracleLib: oracleLib.address },
        })
      ).deploy(
        params.fallBackPrice,
        params.tokenChainlinkFeed as string,
        mockChainlinkFeed.address,
        params.etokenAddr as string,
        config.rTokenMaxTradeVolume,
        ORACLE_TIMEOUT,
        params.targetName,
        defaultThreshold,
        delayUntilDefault,
        await token.decimals(),
        params.tokenAddr as string,
        euldistributor.address
      )

      await setOraclePrice1(mockChainlinkFeed.address, ZERO)
      // it still doesn't revert
      expect(await invalidTargetPriceEtokenCollateral.strictPrice()).to.be.closeTo(strictPrice, params.delta) 

      // Refresh should mark status IFFY
      await invalidTargetPriceEtokenCollateral.refresh()
      const status4 = await invalidTargetPriceEtokenCollateral.status()
      expect(status3).to.equal(CollateralStatus.IFFY)

      // ORACLE_TIMEOUT
      // Reverts with stale price
      await advanceTime(ORACLE_TIMEOUT.toString())

      // Euler
      await expect(eTokenCollateral.strictPrice()).to.be.revertedWith('StalePrice()')

      // Fallback price is returned
      const [isFallback, price] = await eTokenCollateral.price(true)
      expect(isFallback).to.equal(true)
      expect(price).to.equal(params.fallBackPrice)

      // Refresh should mark status IFFY
      await eTokenCollateral.refresh()
      const status5 = await eTokenCollateral.status()
      expect(status5).to.equal(CollateralStatus.IFFY)

      console.log(
        '\n',
        '- status1 (No UnderlyingPrice) : ', status1, '\n',
        '- status2 (No TargetPrice) : ', status2, '\n',
        '- status3 (Invalid UnderlyingPrice) : ', status3, '\n',
        '- status4 (invalid TargetPric) : ', status4, '\n',
        '- status5 (eTokenCollateral) After Timeout : ', status5, '\n',
        '- price : ', price.toString(), '\n',
        '\n',
        )

    })
  })

  // Note: Here the idea is to test all possible statuses and check all possible paths to default
  // hard default = SOUND -> DISABLED due to an invariant violation
  // This may require to deploy some mocks to be able to force some of these situations
  describe('Collateral Status', () => {

    // Test for soft default
    it('Updates status in case of soft default', async () => {
        // Redeploy plugin using a Chainlink mock feed where we can change the price
        const neweTokenCollateral: EULClaimableETokenWSTETHCollateral = <EULClaimableETokenWSTETHCollateral>await (
          await ethers.getContractFactory('EULClaimableETokenWSTETHCollateral', {
            libraries: { OracleLib: oracleLib.address },
          })
        ).deploy(
          params.fallBackPrice,
          mockChainlinkFeed.address,
          await eTokenCollateral.targetChainlinkFeed(),
          await eTokenCollateral.erc20(),
          await eTokenCollateral.maxTradeVolume(),
          await eTokenCollateral.oracleTimeout(),
          await eTokenCollateral.targetName(),
          await eTokenCollateral.defaultThreshold(),
          await eTokenCollateral.delayUntilDefault(),
          await token.decimals(),
          params.tokenAddr as string,
          euldistributor.address
        )
  
        // Check initial state
        expect(await neweTokenCollateral.status()).to.equal(CollateralStatus.SOUND)
        expect(await neweTokenCollateral.whenDefault()).to.equal(MAX_UINT256)
  
        // Depeg one of the underlying tokens - Reducing price 4% & 6%
        //await setOraclePrice1(neweTokenCollateral.address, fp('1570')) // -4% => throw error
        await setOraclePrice1(mockChainlinkFeed.address, fp('1530')) // -6%
  
        // Force updates - Should update whenDefault and status
        await expect(neweTokenCollateral.refresh())
          .to.emit(neweTokenCollateral, 'CollateralStatusChanged')
          .withArgs(CollateralStatus.SOUND, CollateralStatus.IFFY)
  
        expect(await neweTokenCollateral.status()).to.equal(CollateralStatus.IFFY)
  
        const expectedDefaultTimestamp: BigNumber = bn(await getLatestBlockTimestamp()).add(
          delayUntilDefault
        )
        expect(await neweTokenCollateral.whenDefault()).to.equal(expectedDefaultTimestamp)
  
        // Move time forward past delayUntilDefault
        await advanceTime(Number(delayUntilDefault))
        expect(await neweTokenCollateral.status()).to.equal(CollateralStatus.DISABLED)
  
        // Nothing changes if attempt to refresh after default
        // EToken
        const prevWhenDefault: BigNumber = await neweTokenCollateral.whenDefault()
        await expect(neweTokenCollateral.refresh()).to.not.emit(
          neweTokenCollateral,
          'CollateralStatusChanged'
        )
  
        expect(await neweTokenCollateral.status()).to.equal(CollateralStatus.DISABLED)
        expect(await neweTokenCollateral.whenDefault()).to.equal(prevWhenDefault)

        console.log(
            '\n',
            '- expectedDefaultTimestamp : ', expectedDefaultTimestamp.toString(), '\n',
            '- prevWhenDefault : ', prevWhenDefault.toString(), '\n',
            '\n',
            )
      })
    
    // Test for hard default
    it('Updates status in case of hard default', async () => {
      // Note: In this case requires to use a EToken mock to be able to change the rate
      const ETokenMockFactory: ContractFactory = await ethers.getContractFactory('ETokenMock')
      const symbol = await eToken.symbol()
      const eTokenMock: ETokenMock = <ETokenMock>(
        await ETokenMockFactory.deploy(symbol + ' Token', symbol, params.tokenAddr as string)
      )

      // Set initial exchange rate to the new eToken Mock
      await eTokenMock.setExchangeRate(FP1)

      // Redeploy plugin using the new eToken mock
      const neweTokenCollateral: EULClaimableETokenWSTETHCollateral = <EULClaimableETokenWSTETHCollateral>await (
        await ethers.getContractFactory('EULClaimableETokenWSTETHCollateral', {
          libraries: { OracleLib: oracleLib.address },
        })
      ).deploy(
        params.fallBackPrice,
        await eTokenCollateral.chainlinkFeed(),
        await eTokenCollateral.targetChainlinkFeed(),
        eTokenMock.address,
        await eTokenCollateral.maxTradeVolume(),
        await eTokenCollateral.oracleTimeout(),
        await eTokenCollateral.targetName(),
        await eTokenCollateral.defaultThreshold(),
        await eTokenCollateral.delayUntilDefault(),
        await token.decimals(),
        params.tokenAddr as string,
        euldistributor.address
      )

      // Check initial state
      expect(await neweTokenCollateral.status()).to.equal(CollateralStatus.SOUND)
      expect(await neweTokenCollateral.whenDefault()).to.equal(MAX_UINT256)

      // Decrease rate for eToken, will disable collateral immediately
      await eTokenMock.setExchangeRate(fp('0.99'))

      // Force updates - Should update whenDefault and status for Atokens/CTokens
      await expect(neweTokenCollateral.refresh())
        .to.emit(neweTokenCollateral, 'CollateralStatusChanged')
        .withArgs(CollateralStatus.SOUND, CollateralStatus.DISABLED)

      expect(await neweTokenCollateral.status()).to.equal(CollateralStatus.DISABLED)
      const expectedDefaultTimestamp: BigNumber = bn(await getLatestBlockTimestamp())
      expect(await neweTokenCollateral.whenDefault()).to.equal(expectedDefaultTimestamp)
    })

    it('Reverts if oracle reverts or runs out of gas, maintains status', async () => {
      const InvalidMockV3AggregatorFactory = await ethers.getContractFactory(
        'InvalidMockV3Aggregator'
      )
      const invalidChainlinkFeed: InvalidMockV3Aggregator = <InvalidMockV3Aggregator>(
        await InvalidMockV3AggregatorFactory.deploy(18, BN1)
      )

      const invalidETokenCollateral: EULClaimableETokenWSTETHCollateral = <EULClaimableETokenWSTETHCollateral>(
        await ETokenCollateralFactory.deploy(
          params.fallBackPrice,
          invalidChainlinkFeed.address,
          await eTokenCollateral.targetChainlinkFeed(),
          await eTokenCollateral.erc20(),
          await eTokenCollateral.maxTradeVolume(),
          await eTokenCollateral.oracleTimeout(),
          await eTokenCollateral.targetName(),
          await eTokenCollateral.defaultThreshold(),
          await eTokenCollateral.delayUntilDefault(),
          await token.decimals(),
          params.tokenAddr as string,
          await eTokenCollateral.eulDistributor(),
        )
      )

      // Reverting with no reason
      await invalidChainlinkFeed.setSimplyRevert(true)
      await expect(invalidETokenCollateral.refresh()).to.be.revertedWith('')
      expect(await invalidETokenCollateral.status()).to.equal(CollateralStatus.SOUND)

      // Runnning out of gas (same error)
      await invalidChainlinkFeed.setSimplyRevert(false)
      await expect(invalidETokenCollateral.refresh()).to.be.revertedWith('')
      expect(await invalidETokenCollateral.status()).to.equal(CollateralStatus.SOUND)

      console.log(
        '\n',
        '- [EulClaimableETokenWSTETH] Testing Done', '\n',
        '\n',
        )

    })
  })
})
