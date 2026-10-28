# Veritas as a Hugging Face Docker Space, in showcase mode (sample repositories only).
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Spaces run the container as uid 1000
RUN useradd -m -u 1000 user || true
USER 1000
ENV HOME=/home/user PATH=/home/user/.local/bin:/home/user/.local/share/entire/plugins/bin:$PATH
WORKDIR /home/user

RUN curl -fsSL https://entire.io/install.sh | bash && entire plugin install graph
RUN git config --global user.name "Veritas" && git config --global user.email "veritas@users.noreply.github.com"

ARG VERITAS_REF=main
RUN git clone --depth 1 --branch "$VERITAS_REF" https://github.com/Milliebanned/Veritas.git app
WORKDIR /home/user/app
RUN npm ci

ENV HOST=0.0.0.0 PORT=7860 VERITAS_SANDBOX=local VERITAS_SHOWCASE=1 VERITAS_DAILY_LIMIT=20
EXPOSE 7860
CMD ["npm", "run", "serve"]
