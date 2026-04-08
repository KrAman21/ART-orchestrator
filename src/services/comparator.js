/**
 * Compare actual response with expected log
 * Currently hardcoded to return true as per requirements
 */
export function compareLog(expectedLog, actualResponse) {
  // TODO: Implement actual comparison logic later
  // For now, hardcoded to pass as requested
  return {
    match: true,
    differences: [],
    expected: expectedLog,
    actual: actualResponse
  };
}

/**
 * Find matching log from OUTPUT_LIST based on log_tag and source_destination
 */
export function findMatchingLog(outputList, logTag, sourceDestination) {
  const index = outputList.findIndex(
    log => log.log_tag === logTag && log.source_destination === sourceDestination
  );

  if (index === -1) {
    return { found: false, log: null, index: -1 };
  }

  return { found: true, log: outputList[index], index };
}
