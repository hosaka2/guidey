class DomainException(Exception):
    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class ValidationError(DomainException):
    pass


class LLMError(DomainException):
    pass
