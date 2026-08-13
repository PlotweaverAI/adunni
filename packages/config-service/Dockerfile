FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/config-service/package.json ./packages/config-service/
COPY packages/shared-types/package.json ./packages/shared-types/
RUN npm install --workspace @adunni/config-service --workspace @adunni/shared-types --ignore-scripts
COPY packages/shared-types/ ./packages/shared-types/
RUN npm run build --workspace @adunni/shared-types
COPY packages/config-service/ ./packages/config-service/
RUN npm run build --workspace @adunni/config-service
EXPOSE 3005
CMD ["node", "packages/config-service/dist/server.js"]
