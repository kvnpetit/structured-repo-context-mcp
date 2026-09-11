class TokenAuthenticator:
    """Local token authentication boundary."""

    def validate_access_token(self, token: str) -> bool:
        return token.startswith("access-")


def authenticate_user(token: str) -> bool:
    return TokenAuthenticator().validate_access_token(token)
