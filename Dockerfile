FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data
CMD ["npm", "start"]
