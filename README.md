# Magic Book PDF Service

Microservice for PDF generation using Puppeteer/Chromium. Designed for deployment on Railway with Docker.

## Endpoints
- POST `/api/pdf/generate`
- POST `/api/pdf/generate-text-only`
- POST `/api/pdf/generate-cover`
- GET `/health`

Payload mirrors the existing server:
```json
{
  "story": { "...": "..." },
  "childName": "נועם",
  "childAge": 7,
  "selectedGender": "boy",
  "options": {}
}
```

## Required assets
Copy the `pdf-templates/` directory (HTML + fonts/images) into this service root so paths resolve at runtime.

## Local run
1. `npm install`
2. `npm run dev`
3. `curl http://localhost:8080/health`

## Docker run
```
docker build -t magic-book-pdf-service .
docker run -p 8080:8080 magic-book-pdf-service
```

## Deploy (Render)
1. Create new Render Web Service from Docker
2. Set port to `8080`
3. Copy `pdf-templates/` to the repo for this service
4. Deploy






