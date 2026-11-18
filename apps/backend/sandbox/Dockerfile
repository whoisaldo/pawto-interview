# The judge's image: python:3.11-slim plus the FastAPI stack, so a problem
# can ask for a small web app. Versions match requirements.txt's resolution
# for the API. Nothing else is installed, and runs still get no network.
FROM python:3.11-slim

RUN pip install --no-cache-dir \
      fastapi==0.163.1 \
      starlette==1.10.0 \
      pydantic==2.14.3 \
      pydantic-core==2.50.4 \
    && python -c "import fastapi, pydantic"
