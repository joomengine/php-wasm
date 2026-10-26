<?php
header('Content-Type: application/json; charset=utf-8');
header('X-Request-Method: ' . $_SERVER['REQUEST_METHOD']);
header('Set-Cookie: one=1; Path=/; HttpOnly', false);
header('Set-Cookie: two=2; Path=/; SameSite=Lax', false);
http_response_code(201);
echo json_encode([
    'sapi' => PHP_SAPI,
    'get' => $_GET,
    'post' => $_POST,
    'cookies' => $_COOKIE,
    'body' => file_get_contents('php://input'),
    'method' => $_SERVER['REQUEST_METHOD'],
    'uri' => $_SERVER['REQUEST_URI'],
    'host' => $_SERVER['HTTP_HOST'] ?? null,
    'header' => $_SERVER['HTTP_X_TEST'] ?? null,
    'content_type' => $_SERVER['CONTENT_TYPE'] ?? null,
    'content_length' => $_SERVER['CONTENT_LENGTH'] ?? null,
], JSON_THROW_ON_ERROR);
