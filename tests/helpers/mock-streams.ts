// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';

/**
 * Mock writable stream for testing
 */
export class MockWritableStream extends Writable {
  public written: string[] = [];

  _write(chunk: any, encoding: string, callback: () => void): void {
    this.written.push(chunk.toString());
    callback();
  }

  getWrittenData(): string {
    return this.written.join('');
  }

  clear(): void {
    this.written = [];
  }

  cleanup(): void {
    this.removeAllListeners();
    this.destroy();
  }
}

/**
 * Mock readable stream for testing
 */
export class MockReadableStream extends Readable {
  _read(): void {
    // Do nothing, we'll push data manually
  }

  pushData(data: string | Buffer): void {
    this.push(data);
  }

  endStream(): void {
    this.push(null);
  }

  cleanup(): void {
    this.removeAllListeners();
    this.destroy();
  }
}

/**
 * Create a pair of mock stdin/stdout streams for LSP testing
 */
export function createMockStreamPair() {
  const stdin = new MockWritableStream();
  const stdout = new MockReadableStream();
  const stderr = new MockReadableStream();

  return { stdin, stdout, stderr };
}

/**
 * Helper to send LSP message through mock stream
 */
export function sendLSPMessage(stream: MockReadableStream, message: any): void {
  const content = JSON.stringify(message);
  const contentLength = Buffer.byteLength(content, 'utf-8');
  const header = `Content-Length: ${contentLength}\r\n\r\n`;
  const fullMessage = header + content;
  stream.pushData(fullMessage);
}

/**
 * Helper to parse LSP messages from written data
 */
export function parseLSPMessages(data: string | Buffer): any[] {
  const messages: any[] = [];
  let remaining = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');

  while (remaining.length > 0) {
    const headerStart = remaining.indexOf('Content-Length:');
    if (headerStart === -1) break;

    if (headerStart > 0) {
      remaining = remaining.slice(headerStart);
    }

    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const headerText = remaining.slice(0, headerEnd).toString('ascii');
    const headerMatch = headerText.match(/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i);
    if (!headerMatch) {
      remaining = remaining.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(headerMatch[1], 10);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;

    if (remaining.length < messageEnd) break;

    const messageText = remaining.slice(messageStart, messageEnd).toString('utf8');
    try {
      messages.push(JSON.parse(messageText));
    } catch (e) {
      // Skip malformed messages
    }

    remaining = remaining.slice(messageEnd);
  }

  return messages;
}
