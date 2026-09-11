class PaymentGateway
  def authorizePayment(card_token, amount)
    !card_token.empty? && amount > 0
  end
end
