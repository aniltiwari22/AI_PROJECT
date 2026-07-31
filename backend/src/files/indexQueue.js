const vectorStore = require('../knowledge/vectorStore');

/**
 * Indexes uploaded documents after the response has gone out.
 *
 * A 40KB document stores in ~240ms and embeds in ~17s. Making the upload wait
 * for the embedding made it look 70x slower than it was, for no benefit: a file
 * attached to a question is read directly from its stored text, so the index
 * only matters for *later* questions that do not attach it.
 *
 * Serialised rather than parallel. Ollama holds one embedding model and two
 * documents indexing at once just queue inside it, while a serial queue keeps
 * the progress reporting honest and leaves the model free for actual questions
 * between documents.
 */

const jobs = new Map();
let chain = Promise.resolve();

function add(record, text) {
  jobs.set(record.id, {
    fileId: record.id,
    filename: record.filename,
    state: 'queued',
    queuedAt: Date.now(),
    chunks: null,
    knowledgeId: null,
    error: null
  });

  chain = chain.then(async () => {
    const job = jobs.get(record.id);
    if (!job) return;

    job.state = 'indexing';
    job.startedAt = Date.now();

    try {
      const saved = await vectorStore.addDocument({
        title: record.filename,
        source: `upload:${record.id}`,
        text
      });
      job.state = 'done';
      job.chunks = saved.chunks;
      job.knowledgeId = saved.id;
      job.embedded = saved.embedded;
    } catch (error) {
      // A failed index must not stop the queue, and must not lose the file —
      // the document is already stored and still attachable.
      job.state = 'failed';
      job.error = error.message;
      console.warn(`Indexing ${record.filename} failed: ${error.message}`);
    }

    job.finishedAt = Date.now();
    job.ms = job.finishedAt - job.startedAt;

    // Finished jobs are kept briefly so the UI can report the outcome, then
    // dropped rather than growing without bound.
    setTimeout(() => jobs.delete(record.id), 5 * 60 * 1000).unref?.();
  });

  return chain;
}

function status(fileId) {
  return jobs.get(fileId) || null;
}

function pending() {
  return [...jobs.values()].filter((j) => j.state === 'queued' || j.state === 'indexing');
}

/** Resolves once everything queued so far has finished. For tests. */
function drain() {
  return chain;
}

module.exports = { add, status, pending, drain };
