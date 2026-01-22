const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 Konfigurasi Kredensial Umum
const clientId = "088e21fc-de14-4df5-9008-f545ecd28ad1";
const clientSecret = "p8OOlsOexX5AdDSOgHx1y65Bw";
const username = "LI264GULM";
const pin = "bCY3o1jPJe1JHcI";
const serverKey = "AArMxIUKKz8WZfzdSXcILkiy";
const API_KEY_JAGEL = "ISI_API_KEY_JAGEL_ANDA"; 

// ADMIN DATA
const ADMIN_PHONE = '6282323907426';
const ADMIN_EMAIL = 'kilaufast@gmail.com';

// 📧 Konfigurasi Nodemailer (FIXED: Port 465 SSL & TLS Fix)
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // Port 587 HARUS false
    auth: {
        user: 'kilaufast@gmail.com',
        pass: 'xvtbjkrzjzriosca',
    },
    tls: {
        // Tetap gunakan ini agar tidak ditolak jika sertifikat server hosting Anda berbeda
        rejectUnauthorized: false
    }
});
// 📱 Konfigurasi Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken =  process.env.TWILIO_ACCOUNT_TOKEN;
const twilioClient = twilio(accountSid, authToken);
const twilioFrom = 'whatsapp:+62882005447472';

// 🐘 Konfigurasi Database
const db = mysql.createPool({
    host: '203.161.184.103',
    user: 'kilaugr1_layanan',
    password: '~)ea$[r179HegfyL',
    database: 'kilaugr1_layanan',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// --- FUNGSI UTILITY ---

function logToFile(message) {
    const logPath = path.join(__dirname, 'stderr.log');
    const fullMessage = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFile(logPath, fullMessage, (err) => { if (err) console.error(err); });
}

function getExpiredTimestamp(minutesFromNow = 1440) {
    return moment.tz('Asia/Jakarta').add(minutesFromNow, 'minutes').format('YYYYMMDDHHmmss');
}

function generateSignaturePOST(data, path) {
    const paramsOrder = path.includes('/va') ? 
        ['amount', 'expired', 'bank_code', 'partner_reff', 'customer_id', 'customer_name', 'customer_email', 'clientId'] :
        ['amount', 'expired', 'partner_reff', 'customer_id', 'customer_name', 'customer_email', 'clientId'];

    let rawValue = paramsOrder.map(key => data[key] || '').join('');
    const signToString = path + 'POST' + rawValue.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
    return crypto.createHmac("sha256", serverKey).update(signToString).digest("hex");
}

function generatePartnerReff() {
    return `INV-${moment().format('YYYYMMDDHHmmss')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

const formatIDR = (amount) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);

function formatToWhatsAppNumber(num) {
    if (!num) return null;
    const clean = num.toString().replace(/\D/g, '');
    if (clean.startsWith('0')) return `+62${clean.slice(1)}`;
    return `+${clean}`;
}

// 📧 FUNGSI EMAIL
async function sendEmailNotification(to, subject, htmlContent) {
    const recipient = (to && to.includes('@')) ? to : ADMIN_EMAIL;
    try {
        await transporter.sendMail({ from: 'kilaufast@gmail.com', to: recipient, subject, html: htmlContent });
        return { status: true };
    } catch (error) {
        logToFile(`❌ Email Error to ${recipient}: ${error.message}`);
        return { status: false };
    }
}

// 📱 FUNGSI WHATSAPP CUSTOMER (TEMPLATE ONLY)
async function sendWhatsAppCustomerSuccess(to, variables) {
    const formattedTo = formatToWhatsAppNumber(to) || formatToWhatsAppNumber(ADMIN_PHONE);
    try {
        await twilioClient.messages.create({
            from: twilioFrom,
            to: `whatsapp:${formattedTo}`,
            contentSid: 'HX83d2f6ce8fa5693a942935bb0f44a77d',
            contentVariables: JSON.stringify(variables),
        });
        return { status: true };
    } catch (error) {
        logToFile(`❌ Twilio Error to ${formattedTo}: ${error.message}`);
        return { status: false };
    }
}

// 📱 FUNGSI WHATSAPP ADMIN
async function sendWhatsAppAdminNotification(to, messageBody) {
    const formattedTo = formatToWhatsAppNumber(to) || formatToWhatsAppNumber(ADMIN_PHONE);
    try {
        await twilioClient.messages.create({ from: twilioFrom, to: `whatsapp:${formattedTo}`, body: messageBody });
        return { status: true };
    } catch (error) { logToFile(`❌ Admin WA Error: ${error.message}`); return { status: false }; }
}

// 🔄 DATABASE HELPERS
async function insertOrderService(body, partnerReff) {
    const extraServicesJson = body.jasaTambahan ? JSON.stringify(body.jasaTambahan) : null;
    const extraServicesPrice = body.jasaTambahan ? body.jasaTambahan.reduce((acc, curr) => acc + curr.harga, 0) : 0;
    const [result] = await db.execute(
        `INSERT INTO order_service (order_reff, customer_name, customer_phone, customer_email, service_name, service_price, location, address, notes, extra_services, extra_services_price, building_type, building_fee, total_amount, payment_method, payment_code, schedule_date, schedule_time, order_status, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', NOW())`,
        [partnerReff, body.kontak.nama, body.kontak.telepon, body.kontak.email, body.layanan.nama, body.layanan.harga, body.lokasi, body.alamat, body.catatan || null, extraServicesJson, extraServicesPrice, body.jenisGedung, body.biayaGedung, body.totalBayar, body.metodePembayaran.name, body.metodePembayaran.code, body.jadwal.tanggal, body.jadwal.jam]
    );
    return result.insertId;
}

// ------------------------------------
// ⚡ ENDPOINTS: TRANSAKSI
// ------------------------------------

app.post('/create-va', async (req, res) => {
    try {
        const body = req.body;
        const partner_reff = generatePartnerReff();
        const expired = getExpiredTimestamp();
        const orderServiceId = await insertOrderService(body, partner_reff);

        const signature = generateSignaturePOST({
            amount: body.totalBayar, expired, bank_code: body.metodePembayaran.code, partner_reff, customer_id: body.kontak.nama, customer_name: body.kontak.nama, customer_email: body.kontak.email, clientId
        }, '/transaction/create/va');

        const response = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/va', {
            amount: body.totalBayar, bank_code: body.metodePembayaran.code, partner_reff, username, pin, expired, signature, customer_id: body.kontak.nama, customer_name: body.kontak.nama, customer_email: body.kontak.email, url_callback: "https://layanan.linku.co.id/callback"
        }, { headers: { 'client-id': clientId, 'client-secret': clientSecret } });

        await db.query('INSERT INTO inquiry_va SET ?', [{
            order_service_id: orderServiceId, partner_reff, customer_id: body.kontak.nama, amount: body.totalBayar, bank_name: body.metodePembayaran.name, expired, va_number: response.data?.virtual_account, created_at: new Date(), status: "PENDING"
        }]);

        await sendEmailNotification(body.kontak.email, `Invoice #${partner_reff}`, `<h2>Invoice #${partner_reff}</h2><p>VA: ${response.data?.virtual_account}</p><p>Total: ${formatIDR(body.totalBayar)}</p>`);
        res.json(response.data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/create-qris', async (req, res) => {
    try {
        const body = req.body;
        const partner_reff = generatePartnerReff();
        const expired = getExpiredTimestamp();
        const orderServiceId = await insertOrderService(body, partner_reff);

        const signature = generateSignaturePOST({
            amount: body.totalBayar, expired, partner_reff, customer_id: body.kontak.nama, customer_name: body.kontak.nama, customer_email: body.kontak.email, clientId
        }, '/transaction/create/qris');

        const response = await axios.post('https://api.linkqu.id/linkqu-partner/transaction/create/qris', {
            amount: body.totalBayar, partner_reff, username, pin, expired, signature, customer_id: body.kontak.nama, customer_name: body.kontak.nama, customer_email: body.kontak.email, url_callback: "https://layanan.linku.co.id/callback"
        }, { headers: { 'client-id': clientId, 'client-secret': clientSecret } });

        let qrisBuffer = null;
        if (response.data?.imageqris) {
            const imgRes = await axios.get(response.data.imageqris, { responseType: 'arraybuffer' });
            qrisBuffer = Buffer.from(imgRes.data);
        }

        await db.execute(`INSERT INTO inquiry_qris (order_service_id, partner_reff, customer_id, amount, expired, qris_url, qris_image, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'PENDING')`,
            [orderServiceId, partner_reff, body.kontak.nama, body.totalBayar, expired, response.data?.imageqris, qrisBuffer]);

        await sendEmailNotification(body.kontak.email, `Invoice #${partner_reff}`, `<p>Silakan bayar QRIS: <a href="${response.data?.imageqris}">Klik Di Sini</a></p>`);
        res.json(response.data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ------------------------------------
// ⚡ CALLBACK (DENGAN JAGEL NOTIF)
// ------------------------------------
app.post('/callback', async (req, res) => {
    const { partner_reff, va_code } = req.body;
    try {
        const [rows] = await db.query('SELECT * FROM order_service WHERE order_reff = ?', [partner_reff]);
        const orderData = rows[0];
        if (!orderData || orderData.order_status === 'PAID') return res.json({ message: "Done" });

        const table = va_code === 'QRIS' ? 'inquiry_qris' : 'inquiry_va';
        await db.execute(`UPDATE ${table} SET status = 'SUKSES', updated_at = NOW() WHERE partner_reff = ?`, [partner_reff]);
        await db.execute(`UPDATE order_service SET order_status = 'PAID', updated_at = NOW() WHERE order_reff = ?`, [partner_reff]);

        // Fallback Logic
        const customerName = orderData.customer_name || "Pelanggan";
        const serviceName = orderData.service_name || "-";
        const totalAmountFormatted = formatIDR(orderData.total_amount);
        let detailJasa = "-";
        if (orderData.extra_services) {
            try { const extras = JSON.parse(orderData.extra_services); detailJasa = extras.map(i => i.nama).join(', '); } catch (e) {}
        }

        // 1. Jagel Notification
        try {
            await axios.post('https://api.jagel.id/v1/message/send', {
                apikey: "z4PBduE9ocedWaaTUCKHnOl7C8yokkTB4catk7FMt5U2d4Lmyv", type: 'email', value: orderData.customer_email || ADMIN_EMAIL,
                content: `✅ *PEMBAYARAN BERHASIL!*\n\nInvoice: ${partner_reff}\nLayanan: ${serviceName}\nTotal: ${totalAmountFormatted}`
            });
        } catch (e) { logToFile(`Jagel Error: ${e.message}`); }

        // 2. WhatsApp Customer (Template)
        await sendWhatsAppCustomerSuccess(orderData.customer_phone, { 1: customerName, 2: partner_reff, 3: serviceName, 4: detailJasa, 5: orderData.schedule_date, 6: orderData.schedule_time, 7: totalAmountFormatted });

        // 3. WhatsApp Admin
        await sendWhatsAppAdminNotification(ADMIN_PHONE, `✅ *PEMBAYARAN MASUK*\nInv: ${partner_reff}\nCust: ${customerName}\nTotal: ${totalAmountFormatted}`);

        // 4. Email Konfirmasi
        await sendEmailNotification(orderData.customer_email, `Lunas #${partner_reff}`, `<h3>Terima Kasih</h3><p>Pesanan ${partner_reff} lunas.</p>`);

        res.json({ message: "OK" });
    } catch (err) { logToFile(`Callback Error: ${err.message}`); res.status(500).send("Error"); }
});

// ------------------------------------
// ⚡ ENDPOINTS: LIST & STATUS (LENGKAP)
// ------------------------------------

app.get('/va-list', async (req, res) => {
    const { username } = req.query;
    try {
        const [results] = await db.query(`SELECT bank_name, va_number, amount, status, partner_reff, expired, created_at FROM inquiry_va WHERE customer_id = ? ORDER BY created_at DESC LIMIT 5`, [username]);
        res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/qr-list', async (req, res) => {
    const { username } = req.query;
    try {
        const [results] = await db.query(`SELECT partner_reff, amount, status, qris_url, expired, created_at FROM inquiry_qris WHERE customer_id = ? ORDER BY created_at DESC LIMIT 5`, [username]);
        res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/check-status/:partnerReff', async (req, res) => {
    const partner_reff = req.params.partnerReff;
    try {
        const response = await axios.get(`https://api.linkqu.id/linkqu-partner/transaction/payment/checkstatus`, {
            params: { username, partnerreff: partner_reff }, headers: { 'client-id': clientId, 'client-secret': clientSecret }
        });
        if (response.data.status_code === '00') {
            await db.execute(`UPDATE order_service SET order_status = 'PAID' WHERE order_reff = ?`, [partner_reff]);
        }
        res.json(response.data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/transaction-history', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email is required" });
    try {
        const [orders] = await db.query(`
            SELECT os.order_reff, os.service_name, os.total_amount, os.order_status, os.created_at, os.payment_method,
            va.va_number, va.bank_name, qr.qris_url FROM order_service os
            LEFT JOIN inquiry_va va ON os.order_reff = va.partner_reff
            LEFT JOIN inquiry_qris qr ON os.order_reff = qr.partner_reff
            WHERE os.customer_email = ? ORDER BY os.created_at DESC`, [email]);
        res.json(orders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/download-qr/:partner_reff', async (req, res) => {
    const partner_reff = req.params.partner_reff;
    try {
        const [check] = await db.query('SELECT qris_image, qris_url FROM inquiry_qris WHERE partner_reff = ?', [partner_reff]);
        let buffer = check[0]?.qris_image;
        if (!buffer && check[0]?.qris_url) {
            const response = await axios.get(check[0].qris_url, { responseType: 'arraybuffer' });
            buffer = Buffer.from(response.data);
            await db.query('UPDATE inquiry_qris SET qris_image = ? WHERE partner_reff = ?', [buffer, partner_reff]);
        }
        res.setHeader('Content-Disposition', `attachment; filename="qris-${partner_reff}.png"`);
        res.setHeader('Content-Type', 'image/png');
        res.send(buffer);
    } catch (err) { res.status(500).send('Error'); }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Server TangerangFast on port ${PORT}`));