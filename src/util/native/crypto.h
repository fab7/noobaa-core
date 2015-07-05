#ifndef CRYPTO_H_
#define CRYPTO_H_

#include "common.h"
#include "buf.h"

#include <openssl/evp.h>
#include <openssl/sha.h>
#include <openssl/err.h>

class Crypto
{
public:

    static void init();
    static void destroy();

    static inline std::string digest(Buf buf, const char* digest_name)
    {
        const EVP_MD *md = EVP_get_digestbyname(digest_name);
        uint8_t digest[EVP_MAX_MD_SIZE];
        uint32_t digest_len;
        EVP_MD_CTX ctx_md;
        EVP_MD_CTX_init(&ctx_md);
        EVP_DigestInit_ex(&ctx_md, md, NULL);
        EVP_DigestUpdate(&ctx_md, buf.data(), buf.length());
        EVP_DigestFinal_ex(&ctx_md, digest, &digest_len);
        EVP_MD_CTX_cleanup(&ctx_md);
        std::string str;
        for (uint32_t i=0; i<digest_len; ++i) {
            str += BYTE_TO_HEX[digest[i]];
        }
        return str;
    }

    static Buf encrypt(Buf buf, Buf key, Buf iv, const char* cipher_name)
    {
        const EVP_CIPHER *cipher = EVP_get_cipherbyname(cipher_name);
        EVP_CIPHER_CTX ctx_cipher;
        EVP_CIPHER_CTX_init(&ctx_cipher);
        EVP_EncryptInit_ex(&ctx_cipher, cipher, NULL, NULL, NULL);
        assert(key.length() == EVP_CIPHER_CTX_key_length(&ctx_cipher));
        // iv is required if the key is reused, but can be empty if the key is unique
        assert(iv.length() == EVP_CIPHER_CTX_iv_length(&ctx_cipher) || iv.length() == 0);
        EVP_EncryptInit_ex(&ctx_cipher, cipher, NULL, key.data(), iv.length() ? iv.data() : NULL);
        int out_len = 0;
        int final_len = 0;
        Buf out(buf.length() + EVP_CIPHER_CTX_block_size(&ctx_cipher));
        EVP_EncryptUpdate(&ctx_cipher, out.data(), &out_len, buf.data(), buf.length());
        EVP_EncryptFinal_ex(&ctx_cipher, out.data() + out_len, &final_len);
        EVP_CIPHER_CTX_cleanup(&ctx_cipher);
        out.slice(0, out_len + final_len);
        return out;
    }

private:
    static const char* BYTE_TO_HEX[256];
};

#endif // CRYPTO_H_
