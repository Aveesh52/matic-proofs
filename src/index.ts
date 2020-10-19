import { Contract } from "@ethersproject/contracts";
import { JsonRpcProvider, Provider } from "@ethersproject/providers";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { keccak256 as solidityKeccak256 } from "@ethersproject/solidity";

import { bufferToHex, rlp } from "ethereumjs-util";
import checkpointManagerABI from "./abi/ICheckpointManager.json";
import rootChainABI from "./abi/RootChainManager.json";

import { ExitProof, RequiredBlockMembers } from "./types";
import { buildBlockProof } from "./proofs/blockProof";
import { getReceiptBytes, getReceiptProof } from "./proofs/receiptProof";
import { getFullBlockByHash } from "./utils/blocks";
import { findBlockCheckpoint } from "./utils/checkpoint";
import { getLogIndex } from "./utils/logIndex";

export { getReceiptProof } from "./proofs/receiptProof";

export const encodePayload = ({
  headerBlockNumber,
  blockProof,
  burnTxBlockNumber,
  burnTxBlockTimestamp,
  transactionsRoot,
  receiptsRoot,
  receipt,
  receiptProofParentNodes,
  receiptProofPath,
  logIndex,
}: ExitProof): string =>
  bufferToHex(
    rlp.encode([
      headerBlockNumber,
      bufferToHex(Buffer.concat(blockProof)),
      burnTxBlockNumber,
      burnTxBlockTimestamp,
      bufferToHex(transactionsRoot),
      bufferToHex(receiptsRoot),
      bufferToHex(receipt),
      bufferToHex(rlp.encode(receiptProofParentNodes)),
      bufferToHex(receiptProofPath),
      logIndex,
    ]),
  );

export const isBurnTxProcessed = async (
  rootChainProvider: Provider,
  maticChainProvider: JsonRpcProvider,
  rootChainContractAddress: string,
  burnTxHash: string,
  logEventSig: string,
): Promise<boolean> => {
  const rootChainContract = new Contract(rootChainContractAddress, rootChainABI, rootChainProvider);

  const burnTxReceipt = await maticChainProvider.getTransactionReceipt(burnTxHash);
  if (typeof burnTxReceipt.blockNumber === "undefined") {
    throw new Error("Could not find find blocknumber of burn transaction");
  }

  const logIndex = getLogIndex(burnTxReceipt, logEventSig);

  const burnTxBlock: RequiredBlockMembers = await getFullBlockByHash(maticChainProvider, burnTxReceipt.blockHash);
  const { path } = await getReceiptProof(maticChainProvider, burnTxReceipt, burnTxBlock);

  const nibbleArr: Buffer[] = [];
  path.forEach(byte => {
    nibbleArr.push(Buffer.from("0" + (byte / 0x10).toString(16), "hex"));
    nibbleArr.push(Buffer.from("0" + (byte % 0x10).toString(16), "hex"));
  });

  // The first byte must be dropped from receiptProof.path
  const exitHash = solidityKeccak256(
    ["uint256", "bytes", "uint256"],
    [burnTxReceipt.blockNumber, bufferToHex(Buffer.concat(nibbleArr)), logIndex],
  );
  return rootChainContract.processedExits(exitHash);
};

export const isBurnTxCheckpointed = async (
  rootChainProvider: Provider,
  rootChainContractAddress: string,
  burnTxBlockNumber: BigNumberish,
): Promise<boolean> => {
  const rootChainContract = new Contract(rootChainContractAddress, rootChainABI, rootChainProvider);
  const checkpointManagerAddress = await rootChainContract.checkpointManagerAddress();
  const checkpointManagerContract = new Contract(checkpointManagerAddress, checkpointManagerABI, rootChainProvider);
  const lastChildBlock = await checkpointManagerContract.getLastChildBlock();

  return BigNumber.from(lastChildBlock).gte(burnTxBlockNumber);
};

export const buildPayloadForExit = async (
  rootChainProvider: Provider,
  maticChainProvider: JsonRpcProvider,
  rootChainContractAddress: string,
  burnTxHash: string,
  logEventSig: string,
): Promise<ExitProof> => {
  // Check that we can actually confirm that the burn transaction exists
  const burnTx = await maticChainProvider.getTransaction(burnTxHash);
  if (typeof burnTx === null) {
    throw new Error("Could not find transaction corresponding to burnTxHash");
  } else if (typeof burnTx.blockNumber === "undefined") {
    throw new Error("Could not find blocknumber of burnTx");
  } else if (typeof burnTx.blockHash === "undefined") {
    throw new Error("Could not find blockHash of burnTx");
  }

  // Check that the block containing the burn transaction is checkpointed on mainnet.
  if (!isBurnTxCheckpointed(rootChainProvider, rootChainContractAddress, burnTx.blockNumber)) {
    throw new Error("Burn transaction has not been checkpointed as yet");
  }

  const [checkpointId, checkpoint] = await findBlockCheckpoint(
    rootChainProvider,
    rootChainContractAddress,
    burnTx.blockNumber,
  );

  // Build proof that block containing burnTx is included in Matic chain.
  // Proves that a block with the stated blocknumber has been included in a checkpoint
  const blockProof = await buildBlockProof(
    maticChainProvider,
    BigNumber.from(checkpoint.start).toNumber(),
    BigNumber.from(checkpoint.end).toNumber(),
    burnTx.blockNumber,
  );

  // Build proof that the burn transaction is included in this block.
  const burnTxBlock: RequiredBlockMembers = await getFullBlockByHash(maticChainProvider, burnTx.blockHash);
  const receipt = await maticChainProvider.getTransactionReceipt(burnTxHash);

  const logIndex = getLogIndex(receipt, logEventSig);

  const receiptProof = await getReceiptProof(maticChainProvider, receipt, burnTxBlock);

  return {
    headerBlockNumber: checkpointId.toNumber(),
    blockProof,
    burnTxBlockNumber: BigNumber.from(burnTx.blockNumber).toNumber(),
    burnTxBlockTimestamp: BigNumber.from(burnTxBlock.timestamp).toNumber(),
    transactionsRoot: Buffer.from(burnTxBlock.transactionsRoot.slice(2), "hex"),
    receiptsRoot: Buffer.from(burnTxBlock.receiptsRoot.slice(2), "hex"),
    receipt: getReceiptBytes(receipt), // rlp encoded
    receiptProofParentNodes: receiptProof.parentNodes,
    receiptProofPath: receiptProof.path,
    logIndex,
  };
};
