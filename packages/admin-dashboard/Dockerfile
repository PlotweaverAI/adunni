FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/admin-dashboard/package.json ./packages/admin-dashboard/
RUN npm install --workspace @adunni/admin-dashboard --ignore-scripts
COPY packages/admin-dashboard/ ./packages/admin-dashboard/
EXPOSE 3007
CMD ["node", "packages/admin-dashboard/src/server.js"]
