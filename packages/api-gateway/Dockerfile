FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/api-gateway/package.json ./packages/api-gateway/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/shared-types/tsconfig.json ./packages/shared-types/
COPY packages/security/package.json ./packages/security/
COPY packages/security/tsconfig.json ./packages/security/
RUN npm install --workspace @adunni/api-gateway --workspace @adunni/shared-types --workspace @adunni/security --ignore-scripts
COPY packages/shared-types/ ./packages/shared-types/
RUN npm run build --workspace @adunni/shared-types
COPY packages/security/ ./packages/security/
RUN npm run build --workspace @adunni/security
COPY packages/api-gateway/ ./packages/api-gateway/
COPY index.html ./index.html
RUN npm run build --workspace @adunni/api-gateway
EXPOSE 3000
CMD ["node", "packages/api-gateway/dist/server.js"]
