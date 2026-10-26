<?php
session_start();
$_SESSION['count'] = ($_SESSION['count'] ?? 0) + 1;
header('Content-Type: application/json');
echo json_encode(['count' => $_SESSION['count']], JSON_THROW_ON_ERROR);
session_write_close();
