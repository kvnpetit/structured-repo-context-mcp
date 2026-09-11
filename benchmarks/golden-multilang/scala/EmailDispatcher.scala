final class EmailDispatcher {
  def dispatchWelcomeEmail(address: String): Boolean = {
    address.contains("@")
  }
}
