import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber } from "ethers";
import { parseEther } from "ethers/lib/utils";
import { ethers } from "hardhat";
import sinon from "sinon";
import { ItemType } from "../constants";
import { TestERC1155, TestERC721 } from "../typechain";
import { CreateOrderInput } from "../types";
import * as fulfill from "../utils/fulfill";
import { describeWithFixture } from "./utils/setup";

describeWithFixture(
  "As a user I want to buy multiple listings or accept multiple offers",
  (fixture) => {
    let offerer: SignerWithAddress;
    let secondOfferer: SignerWithAddress;
    let zone: SignerWithAddress;
    let fulfiller: SignerWithAddress;
    let firstStandardCreateOrderInput: CreateOrderInput;
    let secondStandardCreateOrderInput: CreateOrderInput;
    let thirdStandardCreateOrderInput: CreateOrderInput;
    let fulfillAvailableOrdersSpy: sinon.SinonSpy;
    let secondTestErc721: TestERC721;
    let secondTestErc1155: TestERC1155;

    const nftId = "1";
    const erc1155Amount = "3";
    const erc1155Amount2 = "7";
    const ONE = "1";

    beforeEach(async () => {
      fulfillAvailableOrdersSpy = sinon.spy(fulfill, "fulfillAvailableOrders");

      [offerer, secondOfferer, zone, fulfiller] = await ethers.getSigners();

      const TestERC721 = await ethers.getContractFactory("TestERC721");
      secondTestErc721 = await TestERC721.deploy();
      await secondTestErc721.deployed();

      const TestERC1155 = await ethers.getContractFactory("TestERC1155");
      secondTestErc1155 = await TestERC1155.deploy();
      await secondTestErc1155.deployed();
    });

    afterEach(() => {
      fulfillAvailableOrdersSpy.restore();
    });

    describe("Multiple ERC1155s are to be transferred from separate orders", async () => {
      describe("[Buy now] I want to buy ERC1155 listings", async () => {
        beforeEach(async () => {
          const { testErc1155 } = fixture;

          // These will be used in 3 separate orders
          await testErc1155.mint(offerer.address, nftId, erc1155Amount);
          await testErc1155.mint(offerer.address, nftId, erc1155Amount2);
          await secondTestErc1155.mint(
            secondOfferer.address,
            nftId,
            erc1155Amount
          );

          firstStandardCreateOrderInput = {
            offer: [
              {
                itemType: ItemType.ERC1155,
                token: testErc1155.address,
                amount: erc1155Amount,
                identifier: nftId,
              },
            ],
            consideration: [
              {
                amount: parseEther("10").toString(),
                recipient: offerer.address,
              },
            ],
            // 2.5% fee
            fees: [{ recipient: zone.address, basisPoints: 250 }],
            allowPartialFills: true,
          };

          secondStandardCreateOrderInput = {
            offer: [
              {
                itemType: ItemType.ERC1155,
                token: testErc1155.address,
                amount: erc1155Amount2,
                identifier: nftId,
              },
            ],
            consideration: [
              {
                amount: parseEther("10").toString(),
                recipient: offerer.address,
              },
            ],
            // 2.5% fee
            fees: [{ recipient: zone.address, basisPoints: 250 }],
            allowPartialFills: true,
          };

          thirdStandardCreateOrderInput = {
            offer: [
              {
                itemType: ItemType.ERC1155,
                token: secondTestErc1155.address,
                amount: erc1155Amount,
                identifier: nftId,
              },
            ],
            consideration: [
              {
                amount: parseEther("10").toString(),
                recipient: secondOfferer.address,
              },
            ],
            // 2.5% fee
            fees: [{ recipient: zone.address, basisPoints: 250 }],
            allowPartialFills: true,
          };
        });

        describe("Partial fill", () => {
          it("trying to buy max qty of already partially filled order should result in getting the available qty only", async () => {
            const { seaport, testErc1155 } = fixture;

            const firstOrderUseCase = await seaport.createOrder(
              firstStandardCreateOrderInput
            );

            const firstOrder = await firstOrderUseCase.executeAllActions();

            // fill first order - buy 1 nft
            const { executeAllActions } = await seaport.fulfillOrder({
              order: firstOrder,
              accountAddress: fulfiller.address,
              unitsToFill: BigNumber.from(ONE),
            });
            await executeAllActions();

            // check balance
            const bal1 = await testErc1155.balanceOf(fulfiller.address, nftId);
            expect(bal1).to.eq(BigNumber.from(ONE));

            // second order - try to buy max amount
            const { executeAllActions: executeAllActions2 } =
              await seaport.fulfillOrder({
                order: firstOrder,
                accountAddress: fulfiller.address,
                unitsToFill: erc1155Amount,
              });
            await executeAllActions2();

            // check balance again, we should end up with max amount of nfts
            const bal2 = await testErc1155.balanceOf(fulfiller.address, nftId);
            expect(bal2).to.eq(BigNumber.from(erc1155Amount));
          });

          it("trying to buy max qty of already partially filled order while fulfilling multiple orders should result in getting the available qty only", async () => {
            const { seaport, testErc1155 } = fixture;

            const firstOrderUseCase = await seaport.createOrder(
              firstStandardCreateOrderInput
            );

            const firstOrder = await firstOrderUseCase.executeAllActions();

            const secondOrderUseCase = await seaport.createOrder(
              secondStandardCreateOrderInput
            );

            const secondOrder = await secondOrderUseCase.executeAllActions();

            const thirdOrderUseCase = await seaport.createOrder(
              thirdStandardCreateOrderInput,
              secondOfferer.address
            );

            const thirdOrder = await thirdOrderUseCase.executeAllActions();

            // fill first order - buy 1 nft
            const { executeAllActions } = await seaport.fulfillOrder({
              order: firstOrder,
              accountAddress: fulfiller.address,
              unitsToFill: ONE,
            });
            await executeAllActions();

            // check balance
            const bal1 = await testErc1155.balanceOf(fulfiller.address, nftId);
            expect(bal1).to.eq(BigNumber.from(ONE));

            const { actions } = await seaport.fulfillOrders({
              fulfillOrderDetails: [
                { order: firstOrder },
                { order: secondOrder },
                { order: thirdOrder },
              ],
              accountAddress: fulfiller.address,
            });

            expect(actions.length).to.eq(1);

            const action = actions[0];

            await action.transactionMethods.transact();

            const balances = await Promise.all([
              testErc1155.balanceOf(fulfiller.address, nftId),
              secondTestErc1155.balanceOf(fulfiller.address, nftId),
            ]);

            expect(balances[0]).to.equal(BigNumber.from(10));
            expect(balances[1]).to.equal(BigNumber.from(erc1155Amount));

            expect(fulfillAvailableOrdersSpy).calledOnce;
          });
        });
      });
    });
  }
);
