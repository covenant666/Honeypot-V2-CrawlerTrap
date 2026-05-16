// ============================================================
// HoneyPot v2 — Bait Injection Examples
// How to inject the bait script into your HTML pages
// ============================================================

import { getBaitScript } from "honeypot-v2";

// ═══════════════════════════════════════════════════════
// Next.js (App Router) — Root Layout
// ═══════════════════════════════════════════════════════

// File: app/layout.tsx
//
// export default function RootLayout({ children }: { children: React.ReactNode }) {
//   return (
//     <html>
//       <head>
//         <script
//           dangerouslySetInnerHTML={{
//             __html: getBaitScript({
//               paths: [
//                 "/hidden/admin-login",
//                 "/api/v2/internal-users",
//                 "/portal/settings/database",
//               ],
//             }).replace(/<script>|<\/script>/g, "")
//           }}
//         />
//       </head>
//       <body>{children}</body>
//     </html>
//   );
// }

// ═══════════════════════════════════════════════════════
// Express (EJS/Pug/HTML templates)
// ═══════════════════════════════════════════════════════

// In your template:
// <%- getBaitScript({ paths: ["/hidden/admin", "/api/internal"] }).replace(/<script>|<\/script>/g, "") %>

// Or as a response middleware:
//
// app.use((req, res, next) => {
//   const originalSend = res.send;
//   res.send = function(body: any) {
//     if (typeof body === "string" && body.includes("</head>")) {
//       const baitHtml = getBaitScript().replace(/<script>|<\/script>/g, "");
//       body = body.replace("</head>", `${baitHtml}</head>`);
//     }
//     return originalSend.call(this, body);
//   };
//   next();
// });

// ═══════════════════════════════════════════════════════
// Static HTML
// ═══════════════════════════════════════════════════════

// Simply paste the output of getBaitScript() into your <head>:
//
// import { getBaitScript } from "honeypot-v2";
// const html = getBaitScript({ paths: ["/hidden/admin"] });
// console.log(html);
// → Paste the <script>...</script> output into <head>

export { getBaitScript };
