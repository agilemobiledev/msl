/**
 * Copyright (c) 2012-2014 Netflix, Inc.  All rights reserved.
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Message input stream unit tests.
 * 
 * @author Wesley Miaw <wmiaw@netflix.com>
 */
describe("MessageInputStream", function() {
	/** Maximum number of payload chunks to generate. */
    var MAX_PAYLOAD_CHUNKS = 12;
    /** Maximum payload chunk data size in bytes. */
    var MAX_DATA_SIZE = 100; //10 * 1024;
    /** Non-replayable ID acceptance window. */
    var NON_REPLAYABLE_ID_WINDOW = 65536;
    /** I/O operation timeout in milliseconds. */
    var TIMEOUT = 1000;
    /** Maximum read length. */
    var MAX_READ_LEN = MAX_PAYLOAD_CHUNKS * MAX_DATA_SIZE;
    
    /** Random. */
    var random = new Random();
    /** Trusted network MSL context. */
    var trustedNetCtx;
    /** Peer-to-peer MSL context. */
    var p2pCtx;
    /** Header service token crypto contexts. */
    var cryptoContexts = new Array();
    /** Message payloads (initially empty). */
    var payloads = new Array();
    
    var MESSAGE_HEADER;
    var ERROR_HEADER;
    var ENTITY_AUTH_DATA;
    var KEY_REQUEST_DATA = new Array();
    var KEY_RESPONSE_DATA;
    var KEYX_CRYPTO_CONTEXT = undefined, ALT_MSL_CRYPTO_CONTEXT;
    
    var SEQ_NO = 1;
    var MSG_ID = 42;
    var END_OF_MSG = true;
    var DATA = new Uint8Array(32);
    random.nextBytes(DATA);
    
    // Shortcuts.
    var HeaderData = MessageHeader$HeaderData;
    var HeaderPeerData = MessageHeader$HeaderPeerData;
    
    /**
     * A crypto context that always returns false for verify. The other crypto
     * operations are no-ops.
     */
    var RejectingCryptoContext = NullCryptoContext.extend({
        /** @inheritDoc */
        verify: function verify(data, signature, callback) {
            callback.result(false);
        },
    });
    
    /**
     * Increments the provided non-replayable ID by 1, wrapping around to zero
     * if the provided value is equal to {@link MslConstants#MAX_LONG_VALUE}.
     * 
     * @param {number} id the non-replayable ID to increment.
     * @return {number} the non-replayable ID + 1.
     * @throws MslInternalException if the provided non-replayable ID is out of
     *         range.
     */
    function incrementNonReplayableId(id) {
        if (id < 0 || id > MslConstants$MAX_LONG_VALUE)
            throw new MslInternalException("Non-replayable ID " + id + " is outside the valid range.");
        return (id == MslConstants$MAX_LONG_VALUE) ? 0 : id + 1;
    }
    
    /**
     * Create a new input stream containing a MSL message constructed from the
     * provided header and payloads.
     * 
     * @param {Header} header message or error header.
     * @param {Array.<PayloadChunk>} payloads zero or more payload chunks.
     * @param {result: function(InputStream), error: function(Error)} callback
     *        the callback that will receive the input stream containing the
     *        MSL message.
     * @throws IOException if there is an error creating the input stream.
     */
    function generateInputStream(header, payloads, callback) {
    	var baos = new ByteArrayOutputStream();
    	var headerBytes = textEncoding$getBytes(JSON.stringify(header), MslConstants$DEFAULT_CHARSET);
        baos.write(headerBytes, 0, headerBytes.length, TIMEOUT, {
        	result: function(numWritten) { writePayload(0, callback); },
        	timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        	error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        });
        function writePayload(index, callback) {
        	if (index == payloads.length) {
        		callback.result(new ByteArrayInputStream(baos.toByteArray()));
        		return;
        	}
        	
        	var payload = payloads[index];
        	var payloadBytes = textEncoding$getBytes(JSON.stringify(payload), MslConstants$DEFAULT_CHARSET);
        	baos.write(payloadBytes, 0, payloadBytes.length, TIMEOUT, {
        		result: function(numWritten) {
        			writePayload(++index, callback);
        		},
        		timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        }
    }
    
    var initialized = false;
    beforeEach(function() {
    	payloads = [];
    	
    	if (!initialized) {
    	    runs(function() {
    	        MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
    	            result: function(c) { trustedNetCtx = c; },
    	            error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    	        });
    	        MockMslContext$create(EntityAuthenticationScheme.PSK, true, {
    	            result: function(c) { p2pCtx = c; },
    	            error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    	        });
    	    });
    	    waitsFor(function() { return trustedNetCtx && p2pCtx; }, "trustedNetCtx and p2pCtx", 100);
    	    
    		runs(function() {
    			trustedNetCtx.getEntityAuthenticationData(null, {
    				result: function(x) { ENTITY_AUTH_DATA = x; },
    				error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    			});
    		});
    		waitsFor(function() { return ENTITY_AUTH_DATA; }, "entityAuthData", 100);
    		
    		runs(function() {
    			var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, null, null, null, null, null);
    			var peerData = new HeaderPeerData(null, null, null);
    			MessageHeader$create(trustedNetCtx, ENTITY_AUTH_DATA, null, headerData, peerData, {
    				result: function(x) { MESSAGE_HEADER = x; },
    				error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    			});
    			ErrorHeader$create(trustedNetCtx, ENTITY_AUTH_DATA, null, 1, MslConstants$ResponseCode.FAIL, 3, "errormsg", "usermsg", {
    				result: function(x) { ERROR_HEADER = x; },
    				error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    			});
    		});
    		waitsFor(function() { return MESSAGE_HEADER && ERROR_HEADER; }, "headers", 100);

    		var keyxData, encryptionKey, hmacKey, wrappingKey;
    		runs(function() {
    			var keyRequest = new SymmetricWrappedExchange$RequestData(SymmetricWrappedExchange$KeyId.PSK);
    			KEY_REQUEST_DATA.push(keyRequest);
    			var factory = trustedNetCtx.getKeyExchangeFactory(keyRequest.keyExchangeScheme);
    			factory.generateResponse(trustedNetCtx, keyRequest, ENTITY_AUTH_DATA.getIdentity(), {
    				result: function(x) { keyxData = x; },
    				error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    			});
    			
                var mke = new Uint8Array(16);
                var mkh = new Uint8Array(32);
                var mkw = new Uint8Array(16);
                random.nextBytes(mke);
                random.nextBytes(mkh);
                random.nextBytes(mkw);
                CipherKey$import(mke, WebCryptoAlgorithm.AES_CBC, WebCryptoUsage.ENCRYPT_DECRYPT, {
                    result: function(x) { encryptionKey = x; },
                    error: function(e) { expect(function() { throw e; }).not.toThrow(); }
                });
                CipherKey$import(mkh, WebCryptoAlgorithm.HMAC_SHA256, WebCryptoUsage.SIGN_VERIFY, {
                    result: function(x) { hmacKey = x; },
                    error: function(e) { expect(function() { throw e; }).not.toThrow(); }
                });
                CipherKey$import(mkw, WebCryptoAlgorithm.A128KW, WebCryptoUsage.WRAP_UNWRAP, {
                    result: function(x) { wrappingKey = x; },
                    error: function(e) { expect(function() { throw e; }).not.toThrow(); }
                });
    		});
    		waitsFor(function() { return encryptionKey && hmacKey && wrappingKey && keyxData; }, "keys and keyxData", 100);

    		runs(function() {
    			KEY_RESPONSE_DATA = keyxData.keyResponseData;
    			KEYX_CRYPTO_CONTEXT = keyxData.cryptoContext;

    			ALT_MSL_CRYPTO_CONTEXT = new SymmetricCryptoContext(trustedNetCtx, "clientMslCryptoContext", encryptionKey, hmacKey, wrappingKey);

    			initialized = true;
    		});
    	}
    });
    
    it("empty message", function() {
        // An end-of-message payload is expected.
    	var chunk;
    	runs(function() {
            var cryptoContext = MESSAGE_HEADER.cryptoContext;
    		PayloadChunk$create(SEQ_NO, MSG_ID, END_OF_MSG, null, new Uint8Array(0), cryptoContext, {
    			result: function(x) { chunk = x; },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return chunk; }, "chunk", 100);
    	
    	var is;
    	runs(function() {
            payloads.push(chunk);
            generateInputStream(MESSAGE_HEADER, payloads, {
            	result: function(x) { is = x; },
            	error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
    	});
    	waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var buffer;
        runs(function() {
        	mis.read(MAX_READ_LEN, TIMEOUT, {
        		result: function(x) { buffer = x; },
        		timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return buffer !== undefined; }, "buffer", 1000);
        
        var closed;
        runs(function() {
        	expect(mis.getErrorHeader()).toBeNull();
        	expect(mis.getMessageHeader()).toEqual(MESSAGE_HEADER);
        	expect(mis.markSupported()).toBeTruthy();
        	expect(buffer).toBeNull();
        	mis.mark();
        	mis.reset();
        	mis.close(TIMEOUT, {
        	    result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("message with data", function() {
    	// An end-of-message payload is expected.
    	var chunk;
    	runs(function() {
    		var cryptoContext = MESSAGE_HEADER.cryptoContext;
    		PayloadChunk$create(SEQ_NO, MSG_ID, END_OF_MSG, null, DATA, cryptoContext, {
    			result: function(x) { chunk = x; },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return chunk; }, "chunk", 100);
    	
    	var is;
    	runs(function() {
    		payloads.push(chunk);
            generateInputStream(MESSAGE_HEADER, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var buffer;
        runs(function() {
        	mis.read(MAX_READ_LEN, TIMEOUT, {
        		result: function(x) { buffer = new Uint8Array(x); },
        		timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return buffer !== undefined; }, "buffer", 1000);
        
        var closed;
        runs(function() {
        	expect(buffer.length).toEqual(DATA.length);
        	expect(buffer).toEqual(DATA);

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("identity with entity authentication data", function() {
    	var entityAuthData;
        runs(function() {
            trustedNetCtx.getEntityAuthenticationData(null, {
                result: function(x) { entityAuthData = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return entityAuthData; }, "entityAuthData not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, entityAuthData, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
    	var is;
    	runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var ready = false;
        runs(function() {
            mis.isReady({
                result: function(r) { ready = r; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ready; }, "mis ready", 100);
        
        var closed;
        runs(function() {
        	expect(mis.getIdentity()).toEqual(entityAuthData.identity);

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("identity with master token", function() {
        var masterToken;
        runs(function() {
            MslTestUtils.getMasterToken(trustedNetCtx, 1, 1, {
                result: function(t) { masterToken = t; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
    	var is;
    	runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var ready = false;
        runs(function() {
            mis.isReady({
                result: function(r) { ready = r; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ready; }, "mis ready", 100);
        
        var closed;
        runs(function() {
        	expect(mis.getIdentity()).toEqual(masterToken.identity);

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("identity for error header", function() {
		var entityAuthData;
		runs(function() {
			trustedNetCtx.getEntityAuthenticationData(null, {
				result: function(x) { entityAuthData = x; },
				error: function(e) { expect(function() { throw e; }).not.toThrow(); }
			});
		});
		waitsFor(function() { return entityAuthData; }, "entityAuthData", 100);
		
    	var errorHeader;
		runs(function() {
			ErrorHeader$create(trustedNetCtx, entityAuthData, null, 1, MslConstants$ResponseCode.FAIL, 3, "errormsg", "usermsg", {
				result: function(x) { errorHeader = x; },
				error: function(e) { expect(function() { throw e; }).not.toThrow(); }
			});
		});
		waitsFor(function() { return errorHeader; }, "errorHeader", 100);
		
		var is;
    	runs(function() {
            generateInputStream(errorHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var ready = false;
        runs(function() {
            mis.isReady({
                result: function(r) { ready = r; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ready; }, "mis ready", 100);
        
        var closed;
        runs(function() {
        	expect(mis.getIdentity()).toEqual(entityAuthData.identity);

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("revoked entity", function() {
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.NONE, false, {
                result: function(x) { ctx = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx", 100);
        
        var entityAuthData;
        runs(function() {
            ctx.getEntityAuthenticationData(null, {
                result: function(x) { entityAuthData = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return entityAuthData; }, "entityAuthData", 100);
        
        var factory, messageHeader;
        runs(function() {
            factory = new MockUnauthenticatedAuthenticationFactory();
            ctx.addEntityAuthenticationFactory(factory);

            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, entityAuthData, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            factory.setRevokedIdentity(entityAuthData.getIdentity());
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var exception;
        runs(function() {
            mis.isReady({
                result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { exception = e; }
            });
        });
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslEntityAuthException(MslError.ENTITY_REVOKED));
        });
    });
    
    it("revoked master token", function() {
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
                result: function(x) { ctx = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx", 100);
        
        var factory, masterToken;
        runs(function() {
            factory = new MockTokenFactory();
            ctx.setTokenFactory(factory);
            
            MslTestUtils.getMasterToken(ctx, 1, 1, {
                result: function(t) { masterToken = t; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return factory && masterToken; }, "factory and master token", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            factory.setRevokedMasterToken(masterToken);
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var exception;
        runs(function() {
            mis.isReady({
                result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { exception = e; }
            });
        });
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMasterTokenException(MslError.MASTERTOKEN_IDENTITY_REVOKED));
        });
    });
    
    it("user with no user ID token", function() {
    	var is;
    	runs(function() {
            generateInputStream(MESSAGE_HEADER, payloads, {
            	result: function(x) { is = x; },
            	error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
    	});
    	waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var ready = false;
        runs(function() {
            mis.isReady({
                result: function(r) { ready = r; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ready; }, "mis ready", 100);
        
        var closed;
        runs(function() {
        	expect(mis.getUser()).toBeNull();

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("user with user ID token", function() {
    	var masterToken;
        runs(function() {
            MslTestUtils.getMasterToken(trustedNetCtx, 1, 1, {
                result: function(t) { masterToken = t; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        var userIdToken;
        runs(function() {
        	MslTestUtils.getUserIdToken(trustedNetCtx, masterToken, 1, MockEmailPasswordAuthenticationFactory.USER, {
        		result: function(t) { userIdToken = t; },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return userIdToken; }, "userIdToken not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, null, null, userIdToken, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
    	var is;
    	runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var ready = false;
        runs(function() {
            mis.isReady({
                result: function(r) { ready = r; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ready; }, "mis ready", 100);
        
        var closed;
        runs(function() {
        	expect(mis.getUser()).toEqual(userIdToken.user);

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("revoked user ID token", function() {
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
                result: function(x) { ctx = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx", 100);
        
        var factory, masterToken;
        runs(function() {
            factory = new MockTokenFactory();
            ctx.setTokenFactory(factory);

            MslTestUtils.getMasterToken(ctx, 1, 1, {
                result: function(t) { masterToken = t; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        var userIdToken;
        runs(function() {
            MslTestUtils.getUserIdToken(ctx, masterToken, 1, MockEmailPasswordAuthenticationFactory.USER, {
                result: function(t) { userIdToken = t; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return userIdToken; }, "userIdToken not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, null, null, userIdToken, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            factory.setRevokedUserIdToken(userIdToken);
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var exception;
        runs(function() {
            mis.isReady({
                result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { exception = e; }
            });
        });
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslUserIdTokenException(MslError.USERIDTOKEN_REVOKED));
        });
    });
    
    it("untrusted user ID token", function() {
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
                result: function(x) { ctx = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx", 100);
        
        var factory, masterToken;
        runs(function() {
            factory = new MockTokenFactory();
            ctx.setTokenFactory(factory);

            MslTestUtils.getMasterToken(ctx, 1, 1, {
                result: function(t) { masterToken = t; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        var userIdToken;
        runs(function() {
            MslTestUtils.getUntrustedUserIdToken(ctx, masterToken, 1, MockEmailPasswordAuthenticationFactory.USER, {
                result: function(t) { userIdToken = t; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return userIdToken; }, "userIdToken not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, null, null, userIdToken, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            factory.setRevokedUserIdToken(userIdToken);
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var exception;
        runs(function() {
            mis.isReady({
                result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { exception = e; }
            });
        });
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslUserIdTokenException(MslError.NONE), MSG_ID);
        });
    });
    
    // FIXME This can be removed once the old handshake logic is removed.
    it("explicit handshake message", function() {
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, true, true, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, ENTITY_AUTH_DATA, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var handshake;
        runs(function() {
            mis.isReady({
                result: function(r) {
                    mis.isHandshake(TIMEOUT, {
                        result: function(x) { handshake = x; },
                        timeout: function() { expect(function() { throw new Error("Timed out waiting for handshake."); }).not.toThrow(); },
                        error: function(e) { expect(function() { throw e; }).not.toThrow(); }
                    });
                },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return handshake; }, "handshake", 100);
        
        var closed;
        runs(function() {
            expect(handshake).toBeTruthy();

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    // FIXME This can be removed once the old handshake logic is removed.
    it("inferred handshake message", function() {
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, true, false, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, ENTITY_AUTH_DATA, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);

        var chunk;
        runs(function() {
            var cryptoContext = MESSAGE_HEADER.cryptoContext;
            PayloadChunk$create(SEQ_NO, MSG_ID, END_OF_MSG, null, new Uint8Array(0), cryptoContext, {
                result: function(x) { chunk = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return chunk; }, "chunk", 100);
        
        var is;
        runs(function() {
            payloads.push(chunk);
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var handshake;
        runs(function() {
            mis.isReady({
                result: function(r) {
                    mis.isHandshake(TIMEOUT, {
                        result: function(x) { handshake = x; },
                        timeout: function() { expect(function() { throw new Error("Timed out waiting for handshake."); }).not.toThrow(); },
                        error: function(e) { expect(function() { throw e; }).not.toThrow(); }
                    });
                },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return handshake; }, "handshake", 100);
        
        var closed;
        runs(function() {
            expect(handshake).toBeTruthy();

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    // FIXME This can be removed once the old handshake logic is removed.
    it("not a handshake message", function() {
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, true, false, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, ENTITY_AUTH_DATA, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);

        var chunk;
        runs(function() {
            var cryptoContext = MESSAGE_HEADER.cryptoContext;
            PayloadChunk$create(SEQ_NO, MSG_ID, END_OF_MSG, null, DATA, cryptoContext, {
                result: function(x) { chunk = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return chunk; }, "chunk", 100);
        
        var is;
        runs(function() {
            payloads.push(chunk);
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var handshake;
        runs(function() {
            mis.isReady({
                result: function(r) {
                    mis.isHandshake(TIMEOUT, {
                        result: function(x) { handshake = x; },
                        timeout: function() { expect(function() { throw new Error("Timed out waiting for handshake."); }).not.toThrow(); },
                        error: function(e) { expect(function() { throw e; }).not.toThrow(); }
                    });
                },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return handshake !== undefined; }, "handshake", 100);
        
        var closed;
        runs(function() {
            expect(handshake).toBeFalsy();

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("message with key response data", function() {
        var entityAuthData;
        runs(function() {
            trustedNetCtx.getEntityAuthenticationData(null, {
                result: function(x) { entityAuthData = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return entityAuthData; }, "entityAuthData not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, KEY_RESPONSE_DATA, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, entityAuthData, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        // Encrypt the payload with the key exchange crypto context.
        var chunk;
        runs(function() {
        	PayloadChunk$create(SEQ_NO, MSG_ID, END_OF_MSG, null, DATA, KEYX_CRYPTO_CONTEXT, {
        		result: function(x) { chunk = x; },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return chunk; }, "chunk", 100);
        
        var is;
        runs(function() {
        	payloads.push(chunk);
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var buffer;
        runs(function() {
        	mis.read(MAX_READ_LEN, TIMEOUT, {
        		result: function(x) { buffer = new Uint8Array(x); },
        		timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return buffer !== undefined; }, "buffer", 1000);
        
        var closed;
        runs(function() {
        	expect(buffer.length).toEqual(DATA.length);
        	expect(buffer).toEqual(DATA);
        	expect(mis.getKeyExchangeCryptoContext()).toEqual(mis.getPayloadCryptoContext());

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("p2p message with key response data", function() {
        var entityAuthData;
        runs(function() {
            p2pCtx.getEntityAuthenticationData(null, {
                result: function(x) { entityAuthData = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return entityAuthData; }, "entityAuthData not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, KEY_RESPONSE_DATA, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(p2pCtx, entityAuthData, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        // Encrypt the payload with the key exchange crypto context.
        var chunk;
        runs(function() {
        	var cryptoContext = messageHeader.cryptoContext;
        	PayloadChunk$create(SEQ_NO, MSG_ID, END_OF_MSG, null, DATA, cryptoContext, {
        		result: function(x) { chunk = x; },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return chunk; }, "chunk", 100);
        var is;
        runs(function() {
        	payloads.push(chunk);
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(p2pCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var buffer;
        runs(function() {
        	mis.read(MAX_READ_LEN, TIMEOUT, {
        		result: function(x) { buffer = new Uint8Array(x); },
        		timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return buffer !== undefined; }, "buffer", 1000);
        
        var closed;
        runs(function() {
	        expect(buffer.length).toEqual(DATA.length);
	        expect(buffer).toEqual(DATA);
	        expect(mis.getPayloadCryptoContext()).not.toEqual(mis.getKeyExchangeCryptoContext());

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("message with unsupported key exchange scheme", function() {
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
                result: function(c) { ctx = c; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx", 100);
        
        var entityAuthData;
        runs(function() {
            ctx.removeKeyExchangeFactories(KeyExchangeScheme.SYMMETRIC_WRAPPED);
            ctx.getEntityAuthenticationData(null, {
                result: function(x) { entityAuthData = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return entityAuthData; }, "entityAuthData not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, KEY_RESPONSE_DATA, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, entityAuthData, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        
        var mis;
        runs(function() {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
        	mis.isReady({
        		result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
        		error: function(e) { exception = e; }
        	});
        });
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslKeyExchangeException(MslError.KEYX_FACTORY_NOT_FOUND, messageid = MSG_ID));
        });
    });
    
    it("missing key request data for message with key response data", function() {
        // We need to replace the MSL crypto context before parsing the message
        // so create a local MSL context.
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
                result: function(c) { ctx = c; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx not received", 100);
        
        var entityAuthData;
        runs(function() {
            ctx.getEntityAuthenticationData(null, {
                result: function(x) { entityAuthData = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return entityAuthData; }, "entityAuthData not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, KEY_RESPONSE_DATA, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, entityAuthData, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            ctx.setMslCryptoContext(new RejectingCryptoContext());
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            var keyRequestData = new Array();
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, keyRequestData, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
            mis.isReady({
                result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { exception = e; }
            });
        });
        waitsFor(function() { return exception; }, "exception", 100);

        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslKeyExchangeException(MslError.KEYX_RESPONSE_REQUEST_MISMATCH, messageid = MSG_ID));
        });
    });
    
    it("incompatible key request data for message with key response data", function() {
        var keyRequestData = new Array();
        keyRequestData.push(new SymmetricWrappedExchange$RequestData(SymmetricWrappedExchange$KeyId.MGK));
        keyRequestData.push(new SymmetricWrappedExchange$RequestData(SymmetricWrappedExchange$KeyId.SESSION));
        
        // We need to replace the MSL crypto context before parsing the message
        // so create a local MSL context.
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
                result: function(c) { ctx = c; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx not received", 100);
        
        var entityAuthData;
        runs(function() {
            ctx.getEntityAuthenticationData(null, {
                result: function(x) { entityAuthData = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return entityAuthData; }, "entityAuthData not received", 100);
        
        var keyExchangeData;
        runs(function() {
            var keyRequest = new SymmetricWrappedExchange$RequestData(SymmetricWrappedExchange$KeyId.PSK);
            var factory = ctx.getKeyExchangeFactory(keyRequest.keyExchangeScheme);
            factory.generateResponse(ctx, keyRequest, entityAuthData.getIdentity(), {
                result: function(x) { keyExchangeData = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return keyExchangeData; }, "keyExchangeData not received", 100);
        
        var messageHeader;
        runs(function() {
            var keyResponseData = keyExchangeData.keyResponseData;
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, keyResponseData, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, entityAuthData, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            ctx.setMslCryptoContext(new RejectingCryptoContext());
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, keyRequestData, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
            mis.isReady({
                result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { exception = e; }
            });
        });
        waitsFor(function() { return exception; }, "exception", 100);

        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslKeyExchangeException(MslError.KEYX_RESPONSE_REQUEST_MISMATCH, messageid = MSG_ID));
        });
    });
    
    it("one compatible key request data for message with key response data", function() {
        // Populate the key request data such that the compatible data requires
        // iterating through one of the incompatible ones.
        var keyRequestData = new Array();
        var keyRequest = new SymmetricWrappedExchange$RequestData(SymmetricWrappedExchange$KeyId.PSK);
        keyRequestData.push(new SymmetricWrappedExchange$RequestData(SymmetricWrappedExchange$KeyId.MGK));
        keyRequestData.push(keyRequest);
        keyRequestData.push(new SymmetricWrappedExchange$RequestData(SymmetricWrappedExchange$KeyId.MGK));
        
        var entityAuthData;
        runs(function() {
            trustedNetCtx.getEntityAuthenticationData(null, {
                result: function(x) { entityAuthData = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return entityAuthData; }, "entityAuthData not received", 100);
        
        var keyExchangeData;
        runs(function() {
            var factory = trustedNetCtx.getKeyExchangeFactory(keyRequest.keyExchangeScheme);
            factory.generateResponse(trustedNetCtx, keyRequest, entityAuthData.getIdentity(), {
                result: function(x) { keyExchangeData = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return keyExchangeData; }, "keyExchangeData not received", 100);
        
        var messageHeader;
        runs(function() {
            var keyResponseData = keyExchangeData.keyResponseData;
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, keyResponseData, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, entityAuthData, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, keyRequestData, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var closed;
        runs(function() {
            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("expired renewable client message with key request data", function() {
        var masterToken;
        runs(function() {
            var renewalWindow = new Date(Date.now() - 20000);
            var expiration = new Date(Date.now() - 10000);
            MasterToken$create(trustedNetCtx, renewalWindow, expiration, 1, 1, null, MockPresharedAuthenticationFactory.PSK_ESN, MockPresharedAuthenticationFactory.KPE, MockPresharedAuthenticationFactory.KPH, {
                result: function(x) { masterToken = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, true, false, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var closed;
        runs(function() {
            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("expired renewable peer message with key request data", function() {
        var masterToken;
        runs(function() {
            var renewalWindow = new Date(Date.now() - 20000);
            var expiration = new Date(Date.now() - 10000);
            MasterToken$create(p2pCtx, renewalWindow, expiration, 1, 1, null, MockPresharedAuthenticationFactory.PSK_ESN, MockPresharedAuthenticationFactory.KPE, MockPresharedAuthenticationFactory.KPH, {
                result: function(x) { masterToken = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, true, false, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(p2pCtx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(p2pCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var closed;
        runs(function() {
            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("expired non-renewable client message", function() {
        // Expired messages received by a trusted network server should be
        // rejected.
        var masterToken;
        runs(function() {
            var renewalWindow = new Date(Date.now() - 20000);
            var expiration = new Date(Date.now() - 10000);
            MasterToken$create(trustedNetCtx, renewalWindow, expiration, 1, 1, null, MockPresharedAuthenticationFactory.PSK_ESN, MockPresharedAuthenticationFactory.KPE, MockPresharedAuthenticationFactory.KPH, {
                result: function(x) { masterToken = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
            	result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
        	mis.isReady({
        		result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
        		error: function(e) { exception = e; }
        	});
        });
        waitsFor(function() { return exception; }, "exception", 100);

        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.MESSAGE_EXPIRED, messageid = MSG_ID));
        });
    });
    
    it("expired renewable client message without key request data", function() {
        // Expired renewable messages received by a trusted network server
        // with no key request data should be rejected.
        var masterToken;
        runs(function() {
            var renewalWindow = new Date(Date.now() - 20000);
            var expiration = new Date(Date.now() - 10000);
            MasterToken$create(trustedNetCtx, renewalWindow, expiration, 1, 1, null, MockPresharedAuthenticationFactory.PSK_ESN, MockPresharedAuthenticationFactory.KPE, MockPresharedAuthenticationFactory.KPH, {
                result: function(x) { masterToken = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, true, false, null, null, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
            	result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
        	mis.isReady({
        		result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
        		error: function(e) { exception = e; }
        	});
        });
        waitsFor(function() { return exception; }, "exception", 100);

        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.MESSAGE_EXPIRED, messageid = MSG_ID));
        });
    });
    
    it("expired non-renewable server message", function() {
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
                result: function(c) { ctx = c; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx", 100);
        
        var masterToken;
        runs(function() {
            var renewalWindow = new Date(Date.now() - 20000);
            var expiration = new Date(Date.now() - 10000);
            MasterToken$create(ctx, renewalWindow, expiration, 1, 1, null, MockPresharedAuthenticationFactory.PSK_ESN, MockPresharedAuthenticationFactory.KPE, MockPresharedAuthenticationFactory.KPH, {
                result: function(x) { masterToken = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        // Expired messages received by a trusted network client should not be
        // rejected.
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);

        var is;
        runs(function() {
            // The master token's crypto context must be cached, as if the client
            // constructed it after a previous message exchange.
            var cryptoContext = new SessionCryptoContext(ctx, masterToken);
            ctx.getMslStore().setCryptoContext(masterToken, cryptoContext);
            
            // Change the MSL crypto context so the master token can no longer be
            // verified or decrypted.
            ctx.setMslCryptoContext(ALT_MSL_CRYPTO_CONTEXT);
            
            // Now "receive" the message with a master token that we cannot verify
            // or decrypt, but for which a cached crypto context exists.
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var closed;
        runs(function() {
            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("expired renewable peer message without key request data", function() {
        var masterToken;
        runs(function() {
            var renewalWindow = new Date(Date.now() - 20000);
            var expiration = new Date(Date.now() - 10000);
            MasterToken$create(p2pCtx, renewalWindow, expiration, 1, 1, null, MockPresharedAuthenticationFactory.PSK_ESN, MockPresharedAuthenticationFactory.KPE, MockPresharedAuthenticationFactory.KPH, {
                result: function(x) { masterToken = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, true, false, null, null, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(p2pCtx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(p2pCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
            	result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
        	mis.isReady({
        		result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
        		error: function(e) { exception = e; }
        	});
        });
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.MESSAGE_EXPIRED, messageid = MSG_ID));
        });
    });
    
    it("expired non-renewable peer message", function() {
        var masterToken;
        runs(function() {
            var renewalWindow = new Date(Date.now() - 20000);
            var expiration = new Date(Date.now() - 10000);
            MasterToken$create(p2pCtx, renewalWindow, expiration, 1, 1, null, MockPresharedAuthenticationFactory.PSK_ESN, MockPresharedAuthenticationFactory.KPE, MockPresharedAuthenticationFactory.KPH, {
                result: function(x) { masterToken = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, false, false, null, null, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(p2pCtx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(p2pCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
            	result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
        	mis.isReady({
        		result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
        		error: function(e) { exception = e; }
        	});
        });
        waitsFor(function() { return exception; }, "exception", 100);

        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.MESSAGE_EXPIRED, messageid = MSG_ID));
        });
    });
    
    it("non-renewable handshake message", function() {
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, 1, false, true, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, ENTITY_AUTH_DATA, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
            mis.isReady({
                result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { exception = e; }
            });
        });
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.HANDSHAKE_DATA_MISSING, messageid = MSG_ID));
        });
    });
    
    it("handshake message without key request data", function() {
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, 1, true, true, null, null, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, ENTITY_AUTH_DATA, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
            mis.isReady({
                result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { exception = e; }
            });
        });
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.HANDSHAKE_DATA_MISSING, messageid = MSG_ID));
        });
    });
    
    it("non-replayable client message without master token", function() {
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, 1, true, false, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, ENTITY_AUTH_DATA, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
            	result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
        	mis.isReady({
        		result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
        		error: function(e) { exception = e; }
        	});
        });
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.INCOMPLETE_NONREPLAYABLE_MESSAGE, messageid = MSG_ID));
        });
    });
    
    it("non-replayable peer message without master token", function() {
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, 1, true, false, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(p2pCtx, ENTITY_AUTH_DATA, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(p2pCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
            	result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
        	mis.isReady({
        		result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
        		error: function(e) { exception = e; }
        	});
        });
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.INCOMPLETE_NONREPLAYABLE_MESSAGE, messageid = MSG_ID));
        });
    });
    
    it("non-replayable with equal non-replayable ID", function() {
        var nonReplayableId = 1;
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
                result: function(x) { ctx = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx", 100);
        
        var masterToken;
        runs(function() {
            MslTestUtils.getMasterToken(ctx, 1, 1, {
                result: function(x) { masterToken = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
            var factory = new MockTokenFactory();
            factory.setLargestNonReplayableId(nonReplayableId);
            ctx.setTokenFactory(factory);
        });
        waitsFor(function() { return masterToken; }, "masterToken", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, nonReplayableId, true, false, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var exception;
        runs(function() {
            mis.isReady({
                result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { exception = e; }
            });
        })
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.MESSAGE_REPLAYED, messageid = MSG_ID));
        });
    });
    
    it("non-replayable with smaller non-replayable ID", function() {
        var nonReplayableId = 2;
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
                result: function(x) { ctx = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx", 100);
        
        var masterToken;
        runs(function() {
            MslTestUtils.getMasterToken(ctx, 1, 1, {
                result: function(x) { masterToken = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
            var factory = new MockTokenFactory();
            factory.setLargestNonReplayableId(nonReplayableId);
            ctx.setTokenFactory(factory);
        });
        waitsFor(function() { return masterToken; }, "masterToken", 100);
        
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, nonReplayableId - 1, true, false, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { exception = e; }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var exception;
        runs(function() {
            mis.isReady({
                result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { exception = e; }
            });
        });
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.MESSAGE_REPLAYED, messageid = MSG_ID));
        });
    });
    
    it("non-replayable with non-replayable ID outside acceptance window", function() {
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
                result: function(x) { ctx = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx", 100);

        var factory = new MockTokenFactory();
        var masterToken;
        runs(function() {
            MslTestUtils.getMasterToken(ctx, 1, 1, {
                result: function(x) { masterToken = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
            ctx.setTokenFactory(factory);
        });
        waitsFor(function() { return masterToken; }, "masterToken", 100);
        
        var complete = false;
        runs(function() {
            iterate();
        });
        waitsFor(function() { return complete; }, "complete", 300);
        
        var largestNonReplayableId = MslConstants$MAX_LONG_VALUE - NON_REPLAYABLE_ID_WINDOW - 1;
        var nonReplayableId = MslConstants$MAX_LONG_VALUE;
        var i = 0, max = 2;
        function iterate() {
            if (i == max) {
                complete = true;
                return;
            }
            
            factory.setLargestNonReplayableId(largestNonReplayableId);
            
            var headerData = new HeaderData(null, MSG_ID, nonReplayableId, true, false, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, null, masterToken, headerData, peerData, {
                result: function(messageHeader) { generate(messageHeader); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        }
        function generate(messageHeader) {
            generateInputStream(messageHeader, payloads, {
                result: function(is) { create(is); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        }
        function create(is) {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(mis) { ready(mis); },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(exception) { check(exception); }
            });
        }
        function ready(mis) {
            mis.isReady({
                result: function() { throw new Error(i + ": Non-replayable ID " + nonReplayableId + " accepted with largest non-replayable ID " + largestNonReplayableId); },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(exception) { check(exception); }
            });
        }
        function check(exception) {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.MESSAGE_REPLAYED_UNRECOVERABLE, messageid = MSG_ID));
            
            largestNonReplayableId = incrementNonReplayableId(largestNonReplayableId);
            nonReplayableId = incrementNonReplayableId(nonReplayableId);
            ++i
            iterate();
        }
    });
    
    it("non-replayable with non-replayable ID inside acceptance window", function() {
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
                result: function(x) { ctx = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx", 100);

        var factory = new MockTokenFactory();
        var masterToken;
        runs(function() {
            MslTestUtils.getMasterToken(ctx, 1, 1, {
                result: function(x) { masterToken = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
            ctx.setTokenFactory(factory);
        });
        waitsFor(function() { return masterToken; }, "masterToken", 100);
        
        var complete = false;
        runs(function() {
            var largestNonReplayableIdA = MslConstants$MAX_LONG_VALUE - NON_REPLAYABLE_ID_WINDOW;
            var nonReplayableIdA = MslConstants$MAX_LONG_VALUE;
            iterate(0, nonReplayableIdA, largestNonReplayableIdA);
        });
        waitsFor(function() { return complete; }, "complete (wraparound)", 10000);
            
        runs(function() {
            complete = false;
            var largestNonReplayableIdB = MslConstants$MAX_LONG_VALUE;
            var nonReplayableIdB = NON_REPLAYABLE_ID_WINDOW - 1;
            iterate(0, nonReplayableIdB, largestNonReplayableIdB);
        });
        waitsFor(function() { return complete; }, "complete (sequential)", 10000);
        
        var max = 2;
        function iterate(i, nonReplayableId, largestNonReplayableId) {
            if (i == max) {
                complete = true;
                return;
            }
            
            factory.setLargestNonReplayableId(largestNonReplayableId);
            
            var headerData = new HeaderData(null, MSG_ID, nonReplayableId, true, false, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, null, masterToken, headerData, peerData, {
                result: function(messageHeader) { generate(messageHeader, i, nonReplayableId, largestNonReplayableId); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        }
        function generate(messageHeader, i, nonReplayableId, largestNonReplayableId) {
            generateInputStream(messageHeader, payloads, {
                result: function(is) { create(is, i, nonReplayableId, largestNonReplayableId); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        }
        function create(is, i, nonReplayableId, largestNonReplayableId) {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(mis) { ready(mis, i, nonReplayableId, largestNonReplayableId); },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        }
        function ready(mis, i, nonReplayableId, largestNonReplayableId) {
            mis.isReady({
                result: function(ready) { check(ready, i, nonReplayableId, largestNonReplayableId); },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw new Error(i + ": Non-replayable ID " + nonReplayableId + " rejected with largest non-replayable ID " + largestNonReplayableId); }).not.toThrow(); }
            });
        }
        function check(ready, i, nonReplayableId, largestNonReplayableId) {
            expect(ready).toBeTruthy();

            largestNonReplayableId = incrementNonReplayableId(largestNonReplayableId);
            nonReplayableId = incrementNonReplayableId(nonReplayableId);
            iterate(i + 1, nonReplayableId, largestNonReplayableId);
        }
    });
    
    it("replayed client message", function() {
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, false, {
                result: function(c) { ctx = c; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx", 100);
        
        var masterToken;
        runs(function() {
            MslTestUtils.getMasterToken(ctx, 1, 1, {
                result: function(t) { masterToken = t; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        var messageHeader;
        runs(function() {
            var factory = new MockTokenFactory();
            factory.setLargestNonReplayableId(1);
            ctx.setTokenFactory(factory);
            
            var headerData = new HeaderData(null, MSG_ID, 1, true, false, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
            	result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
        	mis.isReady({
        		result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
        		error: function(e) { exception = e; }
        	});
        });
        waitsFor(function() { return exception; }, "exception", 100);

        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.MESSAGE_REPLAYED, messageid = MSG_ID));
        });
    });
    
    it("replayed peer message", function() {
        var ctx;
        runs(function() {
            MockMslContext$create(EntityAuthenticationScheme.PSK, true, {
                result: function(c) { ctx = c; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ctx; }, "ctx", 100);
        
        var masterToken;
        runs(function() {
            MslTestUtils.getMasterToken(ctx, 1, 1, {
                result: function(t) { masterToken = t; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return masterToken; }, "masterToken not received", 100);
        
        var messageHeader;
        runs(function() {
            var factory = new MockTokenFactory();
            factory.setLargestNonReplayableId(1);
            ctx.setTokenFactory(factory);
            
            var headerData = new HeaderData(null, MSG_ID, 1, true, false, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(ctx, null, masterToken, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(ctx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
            	result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var exception;
        runs(function() {
        	mis.isReady({
        		result: function() {},
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
        		error: function(e) { exception = e; }
        	});
        });
        waitsFor(function() { return exception; }, "exception", 100);
        
        runs(function() {
            var f = function() { throw exception; };
            expect(f).toThrow(new MslMessageException(MslError.MESSAGE_REPLAYED, messageid = MSG_ID));
        });
    });
    
    it("error header", function() {
        var is;
        runs(function() {
            generateInputStream(ERROR_HEADER, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var ready = false;
        runs(function() {
        	mis.isReady({
        		result: function(r) { ready = r; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return ready; }, "mis ready", 100);
        
        var closed;
        runs(function() {
	        expect(mis.getErrorHeader()).toEqual(ERROR_HEADER);
	        expect(mis.getMessageHeader()).toBeNull();
	        expect(mis.markSupported()).toBeTruthy();
	        
	        mis.mark(0);
	        mis.reset();
            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("read from error header", function() {
        var is;
        runs(function() {
            generateInputStream(ERROR_HEADER, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var ready;
        runs(function() {
            mis.isReady({
                result: function(r) { ready = r; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ready; }, "ready", 100);
        
        var exception;
        runs(function() {
        	mis.read(MAX_READ_LEN, TIMEOUT, {
        		result: function() {},
        		timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        		error: function(e) { exception = e; }
        	});
        });
        waitsFor(function() { return exception; }, "exception", 100);

        runs(function() {
        	var f = function() { throw exception; };
        	expect(f).toThrow(new MslInternalException(MslError.NONE));
        });
    });
    
    it("read from handshake message", function() {
        var messageHeader;
        runs(function() {
            var headerData = new HeaderData(null, MSG_ID, null, true, true, null, KEY_REQUEST_DATA, null, null, null, null);
            var peerData = new HeaderPeerData(null, null, null);
            MessageHeader$create(trustedNetCtx, ENTITY_AUTH_DATA, null, headerData, peerData, {
                result: function(x) { messageHeader = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return messageHeader; }, "messageHeader not received", 100);
        
        var is;
        runs(function() {
            generateInputStream(messageHeader, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var ready;
        runs(function() {
            mis.isReady({
                result: function(r) { ready = r; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis ready."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return ready; }, "ready", 100);
        
        var read;
        runs(function() {
            mis.read(MAX_READ_LEN, TIMEOUT, {
                result: function(x) { read = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return read !== undefined; }, "read", 100);

        runs(function() {
            expect(read).toBeNull();
        });
    });
    
    it("missing end of message", function() {
        var is;
        runs(function() {
            generateInputStream(MESSAGE_HEADER, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);
        
        var buffer;
        runs(function() {
        	mis.read(MAX_READ_LEN, TIMEOUT, {
        		result: function(x) { buffer = x; },
        		timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return buffer !== undefined; }, "buffer", 1000);

        var closed;
        runs(function() {
        	// If there's nothing left we'll receive end of message anyway.
        	expect(buffer).toBeNull();

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("premature end of message", function() {
    	var baos = new ByteArrayOutputStream();
    	var i = 0;
    	runs(function() {
            // Payloads after an end of message are ignored.
        	var extraPayloads = MAX_PAYLOAD_CHUNKS / 2;
        	var cryptoContext = MESSAGE_HEADER.cryptoContext;
    		function writePayload() {
    			if (i == MAX_PAYLOAD_CHUNKS)
    				return;
    			
    			var data = new Uint8Array(random.nextInt(MAX_DATA_SIZE) + 1);
    			random.nextBytes(data);
    			if (i < extraPayloads) {
    				PayloadChunk$create(SEQ_NO + i, MSG_ID, (i == extraPayloads - 1), null, data, cryptoContext, {
    					result: function(chunk) {
    						payloads.push(chunk);
    						baos.write(data, 0, data.length, TIMEOUT, {
    							result: function(success) {
    	    						++i;
    	    						writePayload();
    	    					},
    							timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    							error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    						});
    					},
    					error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    				});
    			} else {
    				PayloadChunk$create(SEQ_NO + i, MSG_ID, null, null, data, cryptoContext, {
    					result: function(chunk) {
    						payloads.push(chunk);
    						++i;
    						writePayload();
    					},
    					error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    				});
    			}
    		}
    		writePayload();
    	});
    	waitsFor(function() { return i == MAX_PAYLOAD_CHUNKS; }, "payloads to be written", 1000);

    	var is;
    	runs(function() {
    		generateInputStream(MESSAGE_HEADER, payloads, {
    			result: function(x) { is = x; },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return is; }, "is", 100);
    	
    	var mis;
    	runs(function() {
    		MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
    			result: function(x) { mis = x; },
    			timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return mis; }, "mis", 100);
        
        var buffer;
        runs(function() {
        	mis.read(MAX_READ_LEN, TIMEOUT, {
        		result: function(x) { buffer = new Uint8Array(x); },
        		timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return buffer !== undefined; }, "buffer", 1000);

        var closed;
    	runs(function() {
	    	// Read everything. We shouldn't get any of the extra payloads.
        	var appdata = baos.toByteArray();
	    	expect(buffer.length).toEqual(appdata.length);
	    	expect(buffer).toEqual(appdata);

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("payload with mismatched message ID", function() {
    	var badPayloads = 0;
    	var baos = new ByteArrayOutputStream();
    	var i = 0;
    	runs(function() {
        	// Payloads with an incorrect message ID should be skipped.
        	var cryptoContext = MESSAGE_HEADER.cryptoContext;
        	var sequenceNumber = SEQ_NO;
    		function writePayload() {
    			if (i == MAX_PAYLOAD_CHUNKS)
    				return;
    			
    			var data = new Uint8Array(random.nextInt(MAX_DATA_SIZE) + 1);
    			random.nextBytes(data);
    			if (random.nextBoolean()) {
    				PayloadChunk$create(sequenceNumber++, MSG_ID, (i == MAX_PAYLOAD_CHUNKS - 1), null, data, cryptoContext, {
    					result: function(chunk) {
    						payloads.push(chunk);
    						baos.write(data, 0, data.length, TIMEOUT, {
    							result: function(success) {
    	    						++i;
    	    						writePayload();
    	    					},
    							timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    							error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    						});
    					},
    					error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    				});
    			} else {
    				PayloadChunk$create(sequenceNumber, 2 * MSG_ID, (i == MAX_PAYLOAD_CHUNKS - 1), null, data, cryptoContext, {
    					result: function(chunk) {
    						payloads.push(chunk);
    						++badPayloads;
    						++i;
    						writePayload();
    					},
    					error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    				});
    			}
    		}
    		writePayload();
    	});
    	waitsFor(function() { return i == MAX_PAYLOAD_CHUNKS; }, "payloads to be written", 1000);
    	
    	var is;
    	runs(function() {
    		generateInputStream(MESSAGE_HEADER, payloads, {
    			result: function(x) { is = x; },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return is; }, "is", 100);
    	
    	var mis;
    	runs(function() {
    		MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
    			result: function(x) { mis = x; },
    			timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return mis; }, "mis", 100);

    	// Read everything. Each bad payload should throw an exception.
    	var buffer = new ByteArrayOutputStream();
    	var caughtExceptions = 0;
    	var eom = false;
    	runs(function() {
    		function nextRead() {
    			mis.read(MAX_READ_LEN, TIMEOUT, {
        			result: function(x) {
        				if (!x) {
        					eom = true;
        					return;
        				}
        				
        				buffer.write(x, 0, x.length, TIMEOUT, {
        					result: function(numWritten) { nextRead(); },
        					timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        					error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        				});
        			},
            		timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
            		error: function(e) {
            			++caughtExceptions;
            			nextRead();
            		}
        		});
    		}
    		nextRead();
    	});
    	waitsFor(function() { return eom; }, "eom", 1000);
    	
    	var closed;
    	runs(function() {
	    	expect(caughtExceptions).toEqual(badPayloads);
	    	var readdata = buffer.toByteArray();
	    	var appdata = baos.toByteArray();
	    	expect(readdata).toEqual(appdata);

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("payload with incorrect sequence number", function() {
        var badPayloads = 0;
        var baos = new ByteArrayOutputStream();
        var i = 0;
        runs(function() {
            // Payloads with an incorrect sequence number should be skipped.
        	var cryptoContext = MESSAGE_HEADER.cryptoContext;
        	var sequenceNumber = SEQ_NO;
    		function writePayload() {
    			if (i == MAX_PAYLOAD_CHUNKS)
    				return;
    			
    			var data = new Uint8Array(random.nextInt(MAX_DATA_SIZE) + 1);
    			random.nextBytes(data);
    			if (random.nextBoolean()) {
    				PayloadChunk$create(sequenceNumber++, MSG_ID, (i == MAX_PAYLOAD_CHUNKS - 1), null, data, cryptoContext, {
    					result: function(chunk) {
    						payloads.push(chunk);
    						baos.write(data, 0, data.length, TIMEOUT, {
    							result: function(success) {
    	    						++i;
    	    						writePayload();
    	    					},
    							timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    							error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    						});
    					},
    					error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    				});
    			} else {
    				PayloadChunk$create(2 * sequenceNumber + i, MSG_ID, (i == MAX_PAYLOAD_CHUNKS - 1), null, data, cryptoContext, {
    					result: function(chunk) {
    						payloads.push(chunk);
    						++badPayloads;
    						++i;
    						writePayload();
    					},
    					error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    				});
    			}
    		}
    		writePayload();
    	});
    	waitsFor(function() { return i == MAX_PAYLOAD_CHUNKS; }, "payloads to be written", 1000);
    	
        var is;
        runs(function() {
            generateInputStream(MESSAGE_HEADER, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        // Read everything. Each bad payload should throw an exception.
    	var buffer = new ByteArrayOutputStream();
        var caughtExceptions = 0;
        var eom = false;
    	runs(function() {
    		function nextRead() {
    			mis.read(MAX_READ_LEN, TIMEOUT, {
        			result: function(x) {
        				if (!x) {
        					eom = true;
        					return;
        				}
        				
        				buffer.write(x, 0, x.length, TIMEOUT, {
        					result: function(numWritten) { nextRead(); },
        					timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        					error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        				});
        			},
            		timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
            		error: function(e) {
            			++caughtExceptions;
            			nextRead();
            		}
        		});
    		}
    		nextRead();
    	});
    	waitsFor(function() { return eom; }, "eom", 1000);

    	var closed;
    	runs(function() {
	    	expect(caughtExceptions).toEqual(badPayloads);
	    	var readdata = buffer.toByteArray();
	    	var appdata = baos.toByteArray();
	    	expect(readdata).toEqual(appdata);

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("read all available", function() {
       var baos;
       var i = 0;
       runs(function() {
           baos = new ByteArrayOutputStream();
           var cryptoContext = MESSAGE_HEADER.cryptoContext;
           function writePayload() {
               if (i == MAX_PAYLOAD_CHUNKS)
                   return;

               var data = new Uint8Array(random.nextInt(MAX_DATA_SIZE) + 1);
               random.nextBytes(data);
               PayloadChunk$create(SEQ_NO + i, MSG_ID, (i == MAX_PAYLOAD_CHUNKS - 1), null, data, cryptoContext, {
                   result: function(chunk) {
                       payloads.push(chunk);
                       baos.write(data, 0, data.length, TIMEOUT, {
                           result: function(success) {
                               ++i;
                               writePayload();
                           },
                           timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                           error: function(e) { expect(function() { throw e; }).not.toThrow(); }
                       });
                   },
                   error: function(e) { expect(function() { throw e; }).not.toThrow(); }
               });
           }
           writePayload();
       });
       waitsFor(function() { return i == MAX_PAYLOAD_CHUNKS; }, "payloads to be written", 1000);
       
       var is;
       runs(function() {
           generateInputStream(MESSAGE_HEADER, payloads, {
               result: function(x) { is = x; },
               error: function(e) { expect(function() { throw e; }).not.toThrow(); }
           });
       });
       waitsFor(function() { return is; }, "is", 100);

       var mis;
       runs(function() {
           MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
               result: function(x) { mis = x; },
               timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
               error: function(e) { expect(function() { throw e; }).not.toThrow(); }
           });
       });
       waitsFor(function() { return mis; }, "mis", 100);
       
       var firstdata;
       runs(function() {
           mis.read(-1, TIMEOUT, {
               result: function(x) {
                   firstdata = new Uint8Array(x.length);
                   firstdata.set(x, 0);
               },
               timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
               error: function(e) { expect(function() { throw e; }).not.toThrow(); }
           });
       });
       waitsFor(function() { return firstdata; }, "read all", 1000);
       
       var closed;
       runs(function() {
           // We should have read the first payload's data.
           expect(firstdata).toEqual(payloads[0].data);

           mis.close(TIMEOUT, {
               result: function(x) { closed = x; },
               timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
               error: function(e) { expect(function() { throw e; }).not.toThrow(); }
           });
       });
       waitsFor(function() { return closed; }, "closed", 100);
    });

    it("mark/reset with read all", function() {
    	var baos;
    	var i = 0;
    	runs(function() {
    		baos = new ByteArrayOutputStream();
    		var cryptoContext = MESSAGE_HEADER.cryptoContext;
    		function writePayload() {
    			if (i == MAX_PAYLOAD_CHUNKS)
    				return;

    			var data = new Uint8Array(random.nextInt(MAX_DATA_SIZE) + 1);
    			random.nextBytes(data);
    			PayloadChunk$create(SEQ_NO + i, MSG_ID, (i == MAX_PAYLOAD_CHUNKS - 1), null, data, cryptoContext, {
    				result: function(chunk) {
    					payloads.push(chunk);
    					baos.write(data, 0, data.length, TIMEOUT, {
    						result: function(success) {
    							++i;
    							writePayload();
    						},
    						timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    						error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    					});
    				},
    				error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    			});
    		}
    		writePayload();
    	});
    	waitsFor(function() { return i == MAX_PAYLOAD_CHUNKS; }, "payloads to be written", 1000);

    	var is;
    	runs(function() {
    		generateInputStream(MESSAGE_HEADER, payloads, {
    			result: function(x) { is = x; },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return is; }, "is", 100);

    	var mis;
    	runs(function() {
    		MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
    			result: function(x) { mis = x; },
    			timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return mis; }, "mis", 100);

    	var appdata, buffer;
    	var firstRead = 0;
    	var beginningOffset, beginningLength;
    	runs(function() {
    		buffer = new Uint8Array(MAX_READ_LEN);
    		appdata = baos.toByteArray();

    		// Mark and reset to the beginning.
    		beginningOffset = 0;
    		beginningLength = Math.floor(appdata.length / 4);
    		mis.mark();
    		mis.read(beginningLength, TIMEOUT, {
    			result: function(x) {
    				buffer.set(x, beginningOffset);
    				firstRead = x.length;
    			},
    			timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return firstRead > 0; }, "first read", 1000);

    	var secondRead = 0;
    	var expectedBeginning;
    	runs(function() {
			expectedBeginning = Arrays$copyOf(appdata, beginningOffset, beginningLength);
			expect(firstRead).toEqual(expectedBeginning.length);
			var actualBeginning = Arrays$copyOf(buffer, beginningOffset, beginningLength);
			expect(actualBeginning).toEqual(expectedBeginning);
			
    		mis.reset();
    		mis.read(beginningLength, TIMEOUT, {
    			result: function(x) {
    				buffer.set(x, beginningOffset);
    				secondRead = x.length;
    			},
    			timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return secondRead > 0; }, "second read", 1000);

    	var thirdRead = 0;
    	var middleOffset, middleLength;
    	runs(function() {
			expect(secondRead).toEqual(expectedBeginning.length);
			var actualBeginning = Arrays$copyOf(buffer, beginningOffset, beginningLength);
			expect(actualBeginning).toEqual(expectedBeginning);
			
    		// Mark and reset from where we are.
    		middleOffset = beginningOffset + beginningLength;
    		middleLength = Math.floor(appdata.length / 4);
    		mis.mark();
    		mis.read(middleLength, TIMEOUT, {
    			result: function(x) {
    				buffer.set(x, middleOffset);
    				thirdRead = x.length;
    			},
    			timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return thirdRead > 0; }, "third read", 1000);

    	var fourthRead = 0;
    	var expectedMiddle;
    	runs(function() {
			expectedMiddle = Arrays$copyOf(appdata, middleOffset, middleLength);
    		expect(thirdRead).toEqual(expectedMiddle.length);
    		var actualMiddle = Arrays$copyOf(buffer, middleOffset, middleLength);
    		expect(actualMiddle).toEqual(expectedMiddle);

    		mis.reset();
    		mis.read(middleLength, TIMEOUT, {
    			result: function(x) {
    				buffer.set(x, middleOffset);
    				fourthRead = x.length;
    			},
    			timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return fourthRead > 0; }, "fourth read", 1000);

    	var fifthRead = 0;
    	var endingOffset, endingLength;
    	runs(function() {
    		expect(fourthRead).toEqual(expectedMiddle.length);
    		var actualMiddle = Arrays$copyOf(buffer, middleOffset, middleLength);
    		expect(actualMiddle).toEqual(expectedMiddle);

    		// Mark and reset the remainder.
    		endingOffset = middleOffset + middleLength;
    		endingLength = appdata.length - middleLength - beginningLength;
    		mis.mark();
    		mis.read(endingLength, TIMEOUT, {
    			result: function(x) {
    				buffer.set(x, endingOffset);
    				fifthRead = x.length;
    			},
    			timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return fifthRead > 0; }, "fifth read", 1000);

    	var sixthRead = 0;
    	var expectedEnding;
    	runs(function() {
    		expectedEnding = Arrays$copyOf(appdata, endingOffset, endingLength);
    		expect(fifthRead).toEqual(expectedEnding.length);
    		var actualEnding = Arrays$copyOf(buffer, endingOffset, endingLength);
    		expect(actualEnding).toEqual(expectedEnding);

    		mis.reset();
    		mis.read(endingLength, TIMEOUT, {
    			result: function(x) {
    				buffer.set(x, endingOffset);
    				sixthRead = x.length;
    			},
    			timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return sixthRead > 0; }, "sixth read", 1000);
    	
    	var seventhRead = 0;
    	runs(function() {
    	    mis.reset();
    	    mis.read(-1, TIMEOUT, {
    	        result: function(x) {
    	            buffer.set(x, endingOffset);
    	            seventhRead = x.length;
    	        },
    	        timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    	        error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    	    });
    	});
    	waitsFor(function() { return seventhRead > 0; }, "seventh read", 1000);
    	
    	var closed;
    	runs(function() {
	    	expect(sixthRead).toEqual(expectedEnding.length);
	    	expect(seventhRead).toEqual(sixthRead);
	    	var actualEnding = Arrays$copyOf(buffer, endingOffset, endingLength);
	    	expect(actualEnding).toEqual(expectedEnding);
	
	    	// Confirm equality.
	    	var actualdata = Arrays$copyOf(buffer, 0, appdata.length);
	    	expect(actualdata).toEqual(appdata);

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });

    it("mark/reset with short mark", function() {
        var baos;
        var i = 0;
        runs(function() {
        	baos = new ByteArrayOutputStream();
        	var cryptoContext = MESSAGE_HEADER.cryptoContext;
        	function writePayload() {
        		if (i == MAX_PAYLOAD_CHUNKS)
        			return;
        		
        		var data = new Uint8Array(random.nextInt(MAX_DATA_SIZE) + 1);
        		random.nextBytes(data);
        		PayloadChunk$create(SEQ_NO + i, MSG_ID, (i == MAX_PAYLOAD_CHUNKS - 1), null, data, cryptoContext, {
        			result: function(chunk) {
        				payloads.push(chunk);
    					baos.write(data, 0, data.length, TIMEOUT, {
    						result: function(success) {
    							++i;
    							writePayload();
    						},
    						timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    						error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    					});
        			},
        			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        		});
        	}
        	writePayload();
        });
        waitsFor(function() { return i == MAX_PAYLOAD_CHUNKS; }, "payloads to be written", 1000);

        var is;
        runs(function() {
            generateInputStream(MESSAGE_HEADER, payloads, {
                result: function(x) { is = x; },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return is; }, "is", 100);
        
        var mis;
        runs(function() {
            MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
                result: function(x) { mis = x; },
                timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return mis; }, "mis", 100);

        var appdata = undefined, buffer;
        var firstRead = 0;
        var beginningOffset, beginningLength;
        runs(function() {
        	buffer = new Uint8Array(MAX_READ_LEN);
        	appdata = baos.toByteArray();

        	// Mark and reset to the beginning.
        	beginningOffset = 0;
        	beginningLength = Math.floor(appdata.length / 2);
        	mis.mark();
        	mis.read(beginningLength, TIMEOUT, {
        		result: function(x) {
    				buffer.set(x, beginningOffset);
    				firstRead = x.length;
    			},
    			timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
    	});
    	waitsFor(function() { return firstRead > 0; }, "first read", 1000);

    	var reread = undefined, rereadLength;
        var expectedBeginning;
        runs(function() {
        	expectedBeginning = Arrays$copyOf(appdata, beginningOffset, beginningLength);
			expect(firstRead).toEqual(expectedBeginning.length);
			var actualBeginning = Arrays$copyOf(buffer, beginningOffset, beginningLength);
			expect(actualBeginning).toEqual(expectedBeginning);
			
    		mis.reset();
        
    		// Read a little bit, and mark again so we drop one or more payloads
    		// but are likely to have more than one payload remaining.
    		rereadLength = Math.floor(appdata.length / 4);
    		mis.read(rereadLength, TIMEOUT, {
    			result: function(x) {
    				reread = x;
    			},
    			timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
        });
        waitsFor(function() { return reread; }, "reread", 1000);
        
        var secondRead;
        var endingOffset, endingLength;
        runs(function() {
    		expect(reread.length).toEqual(rereadLength);
        
    		// Read the remainder, reset, and re-read to confirm.
    		mis.mark();
    		endingOffset = reread.length;
    		endingLength = appdata.length - endingOffset;
    		mis.read(endingLength, TIMEOUT, {
    			result: function(x) {
    				buffer.set(x, endingOffset);
    				secondRead = x.length;
    			},timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
        });
        waitsFor(function() { return secondRead; }, "second read", 1000);

        var finalRead;
        var expectedEnding;
        runs(function() {
	        expectedEnding = Arrays$copyOf(appdata, endingOffset, endingLength);
	        expect(secondRead).toEqual(expectedEnding.length);
	        var actualEnding = Arrays$copyOf(buffer, endingOffset, endingLength);
	        expect(actualEnding).toEqual(expectedEnding);
	        
	        mis.reset();
	        mis.read(endingLength, TIMEOUT, {
    			result: function(x) {
    				buffer.set(x, endingOffset);
    				finalRead = x.length;
    			},timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
        });
        waitsFor(function() { return finalRead; }, "final read", 1000);
        
        var closed;
        runs(function() {
        	expect(finalRead).toEqual(expectedEnding.length);
        	var actualEnding = Arrays$copyOf(buffer, endingOffset, endingLength);
        	expect(actualEnding).toEqual(expectedEnding);
        	
        	// Confirm equality.
        	var actualdata = Arrays$copyOf(buffer, 0, appdata.length);
            expect(actualdata).toEqual(appdata);

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
    
    it("large payload", function() {
    	var data = new Uint8Array(250 * 1024);
    	random.nextBytes(data);
    	
    	var chunk;
    	runs(function() {
        	var cryptoContext = MESSAGE_HEADER.cryptoContext;
    		PayloadChunk$create(SEQ_NO, MSG_ID, true, null, data, cryptoContext, {
    			result: function(x) { chunk = x; },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return chunk; }, "chunk", 1000);
    	
    	var is;
    	runs(function() {
    		payloads.push(chunk);
    		generateInputStream(MESSAGE_HEADER, payloads, {
    			result: function(x) { is = x; },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return is; }, "is", 100);
    	
    	var mis;
    	runs(function() {
    		MessageInputStream$create(trustedNetCtx, is, MslConstants$DEFAULT_CHARSET, KEY_REQUEST_DATA, cryptoContexts, TIMEOUT, {
    			result: function(x) { mis = x; },
    			timeout: function() { expect(function() { throw new Error("Timed out waiting for mis."); }).not.toThrow(); },
    			error: function(e) { expect(function() { throw e; }).not.toThrow(); }
    		});
    	});
    	waitsFor(function() { return mis; }, "mis", 100);

    	var buffer;
    	runs(function() {
    		mis.read(data.length, TIMEOUT, {
        		result: function(x) { buffer = x; },
        		timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return buffer !== undefined; }, "buffer", 1000);
        
        var extra;
        runs(function() {
    		mis.read(1, TIMEOUT, {
        		result: function(x) { extra = x; },
        		timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
        		error: function(e) { expect(function() { throw e; }).not.toThrow(); }
        	});
        });
        waitsFor(function() { return extra !== undefined; }, "extra", 100);
    	
        var closed;
        runs(function() {
        	expect(buffer.length).toEqual(data.length);
        	expect(extra).toBeNull();
        	expect(buffer).toEqual(data);

            mis.close(TIMEOUT, {
                result: function(x) { closed = x; },
                timeout: function() { expect(function() { throw new Error('timedout'); }).not.toThrow(); },
                error: function(e) { expect(function() { throw e; }).not.toThrow(); }
            });
        });
        waitsFor(function() { return closed; }, "closed", 100);
    });
});
