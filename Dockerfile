# FFmpeg render service for the Quiz Question Generator
FROM node:20-bookworm-slim

# ffmpeg + Noto fonts (full Cyrillic support)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       fonts-noto-core \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Noto Sans Bold from fonts-noto-core. Override with FONT_PATH env var.
ENV FONT_PATH=/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf

EXPOSE 3000
CMD ["node", "server.js"]
