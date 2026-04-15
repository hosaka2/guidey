class DomainException(Exception):
    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class ValidationError(DomainException):
    pass


class UnsupportedModeError(ValidationError):
    def __init__(self, mode: str):
        super().__init__(f"Unsupported guide mode: {mode}")


class LLMError(DomainException):
    pass
