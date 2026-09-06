class SessionRepository {
    fun loadSessionById(sessionId: String): String? {
        return if (sessionId.isNotBlank()) "session:$sessionId" else null
    }
}
