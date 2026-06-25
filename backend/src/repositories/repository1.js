const { insertChatLog } = require('../config/db');

module.exports = {
  async saveLog({ prompt, response }) {
    const record = await insertChatLog({ prompt, response });
    console.log(`[Repository Log Saved]: ${prompt.substring(0, 30)}...`);
    return { id: record.id, status: 'committed' };
  }
};
