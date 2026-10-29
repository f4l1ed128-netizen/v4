FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src/ ./src/
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV NODE_ENV=production DATA_DIR=/app/data
CMD ["npm", "start"]
