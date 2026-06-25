const { generateCompletion } = require('../config/ollama');
module.exports = {
  async runInternalInferenceTask(taskData) {
    return await generateCompletion('llama3', taskData, 'Internal engine processor prompt directive.');
  }
};