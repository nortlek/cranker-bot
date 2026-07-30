const EIP1559_ELASTICITY_MULTIPLIER = 2n;
const EIP1559_BASE_FEE_CHANGE_DENOMINATOR = 8n;

/**
 * Computes the exact base fee of an EIP-1559 parent block's immediate child.
 *
 * A private bundle only targets that child, so using the protocol's maximum
 * 12.5% increase overstates gas whenever the parent is not completely full.
 */
export function nextBlockBaseFeePerGas(parameters: {
  readonly parentBaseFeePerGas: bigint;
  readonly parentGasUsed: bigint;
  readonly parentGasLimit: bigint;
}): bigint {
  if (parameters.parentBaseFeePerGas <= 0n) {
    throw new Error("parent base fee must be positive");
  }
  if (parameters.parentGasUsed < 0n) {
    throw new Error("parent gas used cannot be negative");
  }
  if (parameters.parentGasLimit <= 0n) {
    throw new Error("parent gas limit must be positive");
  }
  if (parameters.parentGasUsed > parameters.parentGasLimit) {
    throw new Error("parent gas used cannot exceed its gas limit");
  }

  const parentGasTarget =
    parameters.parentGasLimit / EIP1559_ELASTICITY_MULTIPLIER;
  if (parentGasTarget <= 0n) {
    throw new Error("parent gas target must be positive");
  }
  if (parameters.parentGasUsed === parentGasTarget) {
    return parameters.parentBaseFeePerGas;
  }

  if (parameters.parentGasUsed > parentGasTarget) {
    const gasUsedDelta =
      parameters.parentGasUsed - parentGasTarget;
    const calculatedDelta =
      (parameters.parentBaseFeePerGas * gasUsedDelta) /
      parentGasTarget /
      EIP1559_BASE_FEE_CHANGE_DENOMINATOR;
    const baseFeeDelta =
      calculatedDelta > 0n ? calculatedDelta : 1n;
    return parameters.parentBaseFeePerGas + baseFeeDelta;
  }

  const gasUsedDelta =
    parentGasTarget - parameters.parentGasUsed;
  const baseFeeDelta =
    (parameters.parentBaseFeePerGas * gasUsedDelta) /
    parentGasTarget /
    EIP1559_BASE_FEE_CHANGE_DENOMINATOR;
  return parameters.parentBaseFeePerGas - baseFeeDelta;
}
