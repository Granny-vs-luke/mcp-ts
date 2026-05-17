FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install uv (used by this project for dependency management)
RUN pip install --no-cache-dir uv==0.6.14

# Copy only dependency metadata first for better Docker layer caching
COPY pyproject.toml uv.lock README.md ./

# Install runtime dependencies (no dev)
RUN uv sync --frozen --no-dev

# Copy source code
COPY src ./src

# Railway sets PORT; default in app is 8000.
ENV HOST=0.0.0.0

CMD ["uv", "run", "remote-proxy"]

