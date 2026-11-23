FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js keystore.js ./
RUN mkdir -p data
EXPOSE 8080
USER node
CMD ["node", "server.js"]
