import { Contract } from "@ethersproject/contracts";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";

const checkBlockInCheckpoint = async (
  checkpointManager: Contract,
  targetBlockNumber: BigNumberish,
  checkpointId: BigNumber,
) => {
  const headerBlock = await checkpointManager.headerBlocks(checkpointId.toString());
  const headerStart = BigNumber.from(headerBlock.start);
  const headerEnd = BigNumber.from(headerBlock.end);

  if (headerStart.gt(targetBlockNumber)) {
    // targetBlockNumber was checkpointed before this headerBlock
    return -1;
  }
  if (headerEnd.lt(targetBlockNumber)) {
    // targetBlockNumber was checkpointed after this headerBlock
    return 1;
  }
  // targetBlockNumber is between the upper and lower bounds of the headerBlock, we found our answer
  return 0;
};

/**
 * Searches for checkpoint of a particular childChain block on rootChainManager contract using binary search
 * @param checkpointManager        Ethers contract object for CheckpointManager contract
 * @param blockNumber              Blocknumber on the matic chain of which we are searching for the checkpoint of
 * @returns A BigNumber containing the id of the checkpoint which contains the specified block
 */
export const findBlockCheckpointId = async (
  checkpointManager: Contract,
  childBlockNumber: BigNumberish,
  checkpointIdInterval: BigNumberish = BigNumber.from(10000),
): Promise<BigNumber> => {
  // eslint-disable-next-line no-param-reassign
  childBlockNumber = BigNumber.from(childBlockNumber);
  // first checkpoint id = start * 10000
  let start = BigNumber.from(1);

  // last checkpoint id = end * 10000
  let end = BigNumber.from(await checkpointManager.currentHeaderBlock()).div(checkpointIdInterval);
  if (start.gt(end)) {
    throw new Error("start block is greater than end block");
  }

  // binary search on all the checkpoints to find the checkpoint that contains the childBlockNumber
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (start.eq(end)) {
      return start.mul(checkpointIdInterval);
    }
    const mid = start.add(end).div(2);

    // eslint-disable-next-line no-await-in-loop
    const checkpointStatus = await checkBlockInCheckpoint(
      checkpointManager,
      mid.mul(checkpointIdInterval).toString(),
      childBlockNumber,
    );

    switch (checkpointStatus) {
      case 0:
        // childBlockNumber is in this checkpoint, we found our answer
        return mid.mul(checkpointIdInterval);
      case -1:
        // childBlockNumber was checkpointed before this checkpoint
        end = mid.sub(1);
        break;
      case 1:
        // childBlockNumber was checkpointed after this checkpoint
        start = mid.add(1);
        break;
      default:
        throw new Error("Error finding correct checkpoint ID");
    }
  }
};
