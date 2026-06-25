# Extended helper methods to wrap utility runtime functionality for RAG tasks
def format_rag_context_window(extracted_chunks: list) -> str:
    """Combines text chunks seamlessly for direct injection into system inference engines."""
    return "\n\n---\n\n".join(extracted_chunks)