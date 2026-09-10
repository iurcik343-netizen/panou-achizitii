<?php
// Releu cu IP static pentru SIA "e-Factura" (SFS) — găzduit pe hosting-ul existent (sublime.md),
// pentru că API-ul SFS cere un IP fix la whitelisting, iar Cloudflare Workers nu are unul.
// Primește cererea de la worker-ul MoySklad/NOD, o retransmite către SFS cu IP-ul acestui
// server, și întoarce răspunsul brut înapoi — nu conține nicio logică de business.

// ATENȚIE: înlocuiește valoarea de mai jos cu un secret lung, generat aleator, ȘI pune-l
// identic ca EFACTURA_RELAY_SECRET pe Cloudflare Worker. Nu-l lăsa cu valoarea implicită —
// versiunea reală, gata de încărcat, e livrată separat, nu prin acest fișier din Git.
define('RELAY_SECRET', 'REPLACE_WITH_YOUR_OWN_RANDOM_SECRET');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Content-Type: text/plain');
    echo 'Method not allowed';
    exit;
}

$providedSecret = $_SERVER['HTTP_X_RELAY_SECRET'] ?? '';
if (!hash_equals(RELAY_SECRET, $providedSecret)) {
    http_response_code(403);
    header('Content-Type: text/plain');
    echo 'Forbidden';
    exit;
}

$targetUrl = $_POST['url'] ?? '';
$method = strtoupper($_POST['method'] ?? 'GET');
$headersJson = $_POST['headers'] ?? '{}';
$body = $_POST['body'] ?? '';

// Doar domenii SFS — ca releul să nu poată fi folosit ca proxy general spre orice adresă,
// chiar dacă cineva ar afla secretul.
if (!$targetUrl || !preg_match('#^https://[a-zA-Z0-9.\-]+\.sfs\.md(/|\?|$)#', $targetUrl)) {
    http_response_code(400);
    header('Content-Type: text/plain');
    echo 'Invalid or disallowed target URL';
    exit;
}

$headers = json_decode($headersJson, true);
if (!is_array($headers)) {
    $headers = [];
}
$curlHeaders = [];
foreach ($headers as $key => $value) {
    $curlHeaders[] = $key . ': ' . $value;
}

$ch = curl_init($targetUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HEADER, false);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
if ($method === 'POST') {
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
}
curl_setopt($ch, CURLOPT_HTTPHEADER, $curlHeaders);
curl_setopt($ch, CURLOPT_TIMEOUT, 30);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);

$responseBody = curl_exec($ch);
$httpStatus = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
$curlError = curl_error($ch);
curl_close($ch);

if ($responseBody === false) {
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Eroare cURL la conectarea cu SFS', 'detail' => $curlError]);
    exit;
}

http_response_code($httpStatus ?: 502);
header('Content-Type: ' . ($contentType ?: 'application/octet-stream'));
echo $responseBody;
