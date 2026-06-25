module.exports = {
  name: 'InteractionHistorySchema',
  attributes: {
    id: 'UUID',
    promptContext: 'TEXT',
    completionContext: 'TEXT',
    executionLatencyMs: 'INTEGER'
  }
};