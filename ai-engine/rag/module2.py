# rag moduleimport numpy as np

def cosine_similarity(v1, v2):
    dot_product = np.dot(v1, v2)
    norm_v1 = np.linalg.norm(v1)
    norm_v2 = np.linalg.norm(v2)
    if norm_v1 == 0 or norm_v2 == 0:
        return 0.0
    return float(dot_product / (norm_v1 * norm_v2))

def rank_documents(query_vector, document_vectors, top_k=3):
    scores = [cosine_similarity(query_vector, doc_vec) for doc_vec in document_vectors]
    ranked_indices = np.argsort(scores)[::-1]
    return ranked_indices[:top_k]