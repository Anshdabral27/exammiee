from math import gcd

def modinv(e, phi):
    a, b, x0, x1 = phi, e, 0, 1
    while b:
        q = a // b
        a, b = b, a % b
        x0, x1 = x1, x0 - q * x1
    return x0 % phi
p, q = 17, 11
n = p * q
phi = (p - 1)*(q - 1)
e = 7
while gcd(e, phi)!= 1:
    e += 2
d = modinv(e, phi)
print("public Key:", (e, n))
print("private Key:", (d, n))
encrypt = lambda msg: [pow(ord(c), e, n) for c in msg]

decrypt = lambda cph: ''.join(chr(pow(c, d, n)) for c in cph)
msg = "HI"
c = encrypt(msg)
print("Encrypted:", c)
print("Decrypted:", decrypt(c))