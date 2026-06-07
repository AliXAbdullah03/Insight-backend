const nodemailer = require("nodemailer");

function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

async function sendEmail(to, subject, text) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL,
      pass: process.env.PASSWORD,
    },
  });

  await transporter.sendMail({
    from: process.env.EMAIL,
    to,
    subject,
    text,
  });
}

async function sendOTPEmail({ to, otp }) {
  const subject = "Your One-Time Password (OTP) for Smart Insight";
  const text = `Your OTP is: ${otp}`;
  await sendEmail(to, subject, text);
}

module.exports = {
  generateOTP,
  sendOTPEmail,
};
