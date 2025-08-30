// Simple Certificate Generator API (Node.js + Express)
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { parse } = require('csv-parse');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== In-memory store for uploaded names/emails =====
let participants = []; // [{ name, email? }]
let currentEvent = "Community Event"; // default; can be overwritten via query

// ===== CSV Upload (POST /api/upload) =====
// Accepts a CSV with headers: name,email (email optional)
const upload = multer({ dest: 'uploads/', limits: { fileSize: 5 * 1024 * 1024 }});
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const eventName = req.body.event || currentEvent;
    currentEvent = eventName || currentEvent;

    const filePath = req.file.path;
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(parse({ columns: true, trim: true, skip_empty_lines: true }))
      .on('data', (row) => {
        if (row.name && row.name.trim()) {
          rows.push({ name: row.name.trim(), email: row.email?.trim() || "" });
        }
      })
      .on('end', () => {
        fs.unlinkSync(filePath);
        participants = rows;
        res.json({ ok: true, count: participants.length, event: currentEvent });
      })
      .on('error', (err) => {
        fs.unlinkSync(filePath);
        res.status(400).json({ ok: false, error: err.message });
      });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== Get names (GET /api/names) =====
app.get('/api/names', (req, res) => {
  res.json({ ok: true, event: currentEvent, participants });
});

// ===== PDF Generator (utility) =====
function drawCertificate(doc, name, eventName, { watermark = false } = {}) {
  const W = 842;  // A4 landscape width (pt)
  const H = 595;  // height
  doc.addPage({ size: [W, H], layout: 'landscape', margin: 0 });

  // Background
  doc.rect(0, 0, W, H).fill('#fdfcf7');
  doc.rect(30, 30, W - 60, H - 60).lineWidth(4).stroke('#222');

  // Heading
  doc.fill('#222');
  doc.fontSize(26).font('Helvetica-Bold').text('CERTIFICATE OF PARTICIPATION', 0, 80, { align: 'center' });

  // Subtitle
  doc.fontSize(16).font('Helvetica').text('This is to certify that', 0, 135, { align: 'center' });

  // Recipient Name
  doc.fontSize(48).font('Helvetica-Bold').fill('#111').text(name, 0, 175, { align: 'center' });

  // Body
  doc.fontSize(16).font('Helvetica')
    .text(`has successfully participated in`, 0, 240, { align: 'center' });
  doc.fontSize(22).font('Helvetica-Bold').text(eventName, 0, 270, { align: 'center' });

  // Footer
  const today = new Date().toLocaleDateString();
  doc.fontSize(12).font('Helvetica-Oblique').fill('#333')
     .text(`Date: ${today}`, 70, H - 80);

  // Signature areas
  doc.moveTo(W - 250, H - 120).lineTo(W - 70, H - 120).stroke('#333');
  doc.fontSize(12).font('Helvetica').text('Authorized Signature', W - 250, H - 110, { width: 180, align: 'center' });

  // Watermark
  if (watermark) {
    doc.save();
    doc.rotate(-20, { origin: [W/2, H/2] });
    doc.fontSize(100).fillColor('#cccccc').opacity(0.2)
       .font('Helvetica-Bold').text('SAMPLE', W/2 - 250, H/2 - 60);
    doc.opacity(1).restore();
  }
}

// ===== Preview (GET /api/preview?name=&event=) =====
app.get('/api/preview', (req, res) => {
  const name = (req.query.name || '').trim();
  const eventName = (req.query.event || currentEvent || 'Event').trim();
  if (!name) return res.status(400).send('Missing name');

  res.setHeader('Content-Type', 'application/pdf');

  const doc = new PDFDocument({ autoFirstPage: false });
  doc.on('error', (e) => console.error(e));
  doc.pipe(res);

  drawCertificate(doc, name, eventName, { watermark: true });
  doc.end();
});

// ===== Generate (download) (GET /api/generate?name=&event=) =====
app.get('/api/generate', (req, res) => {
  const name = (req.query.name || '').trim();
  const eventName = (req.query.event || currentEvent || 'Event').trim();
  if (!name) return res.status(400).send('Missing name');

  const filename = `Certificate_${name.replace(/\s+/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ autoFirstPage: false });
  doc.on('error', (e) => console.error(e));
  doc.pipe(res);

  drawCertificate(doc, name, eventName, { watermark: false });
  doc.end();
});

// ===== Optional: Email Certificate (POST /api/email) =====
// body: { name, email, event? }
// Requires SMTP env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL
app.post('/api/email', async (req, res) => {
  try {
    const { name, email, event } = req.body;
    if (!name || !email) return res.status(400).json({ ok: false, error: 'name and email required' });
    const eventName = event || currentEvent || 'Event';

    // Create PDF to a buffer
    const doc = new PDFDocument({ autoFirstPage: false });
    drawCertificate(doc, name, eventName, { watermark: false });
    const pdfBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });

    // Transport
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.FROM_EMAIL || 'no-reply@example.com',
      to: email,
      subject: `Your Certificate - ${eventName}`,
      text: `Hi ${name},\n\nPlease find attached your certificate for ${eventName}.\n\nRegards,\nOrganizer`,
      attachments: [
        { filename: `Certificate_${name.replace(/\s+/g, '_')}.pdf`, content: pdfBuffer }
      ]
    });

    res.json({ ok: true, message: 'Email sent' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== Launch =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running http://localhost:${PORT}`);
  console.log('Open http://localhost:3000 in your browser.');
});
