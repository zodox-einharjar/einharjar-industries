from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    secret_key: str = "changeme"
    debug: bool = False

    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/eve_app"

    eve_client_id: str = ""
    eve_client_secret: str = ""
    eve_callback_url: str = "http://localhost:8000/auth/callback"

    # ESI base URL — versioned endpoints override per-call
    esi_base_url: str = "https://esi.evetech.net/latest"
    esi_user_agent: str = "einharjar-industries/1.0 (your-email@example.com)"

    sde_path: str = "data/sqlite-latest.sqlite"


settings = Settings()
