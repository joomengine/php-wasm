<?php
header('Content-Type: application/octet-stream');
echo file_get_contents('php://input');
