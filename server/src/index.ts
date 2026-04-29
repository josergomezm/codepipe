import express from 'express'

const app = express()

app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

const port = Number(process.env['PORT'] ?? 5551)

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`CodePipe server listening on http://127.0.0.1:${port}`)
})

export { app, server }
