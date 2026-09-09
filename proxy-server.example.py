#!/usr/bin/env python3
"""
Simple proxy server for OpenAI API to avoid CORS issues
Run with: python3 proxy-server.py

SETUP:
1. Copy this file to proxy-server.py
2. Replace YOUR_OPENAI_API_KEY_HERE with your actual OpenAI API key
3. Run: python3 proxy-server.py
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import urllib.request
import urllib.error

# TODO: Replace with your actual OpenAI API key
API_KEY = 'YOUR_OPENAI_API_KEY_HERE'

class ProxyHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        if self.path == '/chat':
            content_length = int(self.headers['Content-Length'])
            body = self.rfile.read(content_length)

            try:
                request_data = json.loads(body)

                openai_request = urllib.request.Request(
                    'https://api.openai.com/v1/chat/completions',
                    data=json.dumps(request_data).encode('utf-8'),
                    headers={
                        'Content-Type': 'application/json',
                        'Authorization': f'Bearer {API_KEY}'
                    }
                )

                with urllib.request.urlopen(openai_request) as response:
                    response_data = response.read()

                self.send_response(200)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(response_data)

            except urllib.error.HTTPError as e:
                error_body = e.read().decode('utf-8')
                self.send_response(e.code)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(error_body.encode('utf-8'))

            except Exception as e:
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                error_msg = json.dumps({'error': {'message': str(e)}})
                self.wfile.write(error_msg.encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        print(f"[Proxy] {args[0]}")

if __name__ == '__main__':
    PORT = 8001

    if API_KEY == 'YOUR_OPENAI_API_KEY_HERE':
        print('ERROR: Please set your OpenAI API key in proxy-server.py')
        print('Edit the file and replace YOUR_OPENAI_API_KEY_HERE with your actual key')
        exit(1)

    server = HTTPServer(('localhost', PORT), ProxyHandler)
    print(f'✓ Proxy server running on http://localhost:{PORT}')
    print(f'✓ API Key loaded (length: {len(API_KEY)})')
    print('✓ Ready to proxy requests to OpenAI')
    print('\nPress Ctrl+C to stop\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n\nShutting down proxy server...')
        server.shutdown()
