#include <Arduino.h>
#include <Wire.h>
#include <BMP180.h>
#include <SI7021.h>
#include <SPI.h>
#include <RF24.h>
#include <string.h>
#include <avr/sleep.h>
#include <avr/eeprom.h>
#include <LowPower.h>
#include <skipjack.h>
#include <hmac-md5.h>

#define EEPROM_ENC_KEY_ADDR 0x00
#define EEPROM_ENC_KEY_SIZE 10
#define EEPROM_SIG_KEY_ADDR 0x0a
#define EEPROM_SIG_KEY_SIZE 4

#define SIG_SIZE 6

#define PAYLOAD_SIZE 17

#define CHANNEL_PIN_0 0
#define CHANNEL_PIN_1 1
#define CHANNEL_PIN_2 10
#define CHANNEL_PIN_3 A3

#define ADDRESS_PIN_0 5
#define ADDRESS_PIN_1 6
#define ADDRESS_PIN_2 7

#define ENCRYPT_PIN A2

#define PROXIMITY_INT 0
#define PROXIMITY_PIN 2
#define BOUNCE_DURATION 20 

#define RF_GOOD_LED 3
#define RF_BAD_LED 4
#define LO_BATT_LED A1

//prototypes

void flash(int pin);
void pulse(int pin);
void rflog(char * msg);
long readVcc();
int getMyAddr();
int getMyChannel();
bool shouldEncrypt();
bool keyIsEmpty(byte * key, int size);
void generateKey(byte * key, int size);
void proximityTrigger();
void sendDataMessage();
void sendPairingMessage();

int myaddr = getMyAddr();
// commented out until hardware supports channel pins
int mychannel = getMyChannel();
int32_t lastmillivolts = 0;

volatile bool proximitytrigger = false;
volatile unsigned long bounceTime=0;

// this struct should always be a multiple of 64 bits so we can easily encrypt it (skipjack 64bit blocks)
// data is passed as integers, therefore decimals are shifted where noted to maintain precision
struct sensordata {
    int8_t   addr         = myaddr;
    bool     proximity    = true; // sensor closed or open
    int16_t  tempc        = 0; // temp in centicelsius
    int16_t  humidity     = 0; // humidity in basis points (percent of percent)
    uint16_t pressuredp   = 0; // pressure in decapascals
    uint16_t millivolts   = 0; // battery voltage millivolts
    uint8_t  signature[SIG_SIZE] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00}; //truncated md5 of sensor data
};

struct pairingdata {
    byte enckey[EEPROM_ENC_KEY_SIZE] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}; // 10 bytes
    byte sigkey[EEPROM_SIG_KEY_SIZE] = {0x00, 0x00, 0x00, 0x00}; // 4 bytes
    int16_t padding = 0; // 2 bytes
};

/* keep messages small, increases radio range. Currently 17 bytes (PAYLOAD_SIZE).

header is one byte that represents the following:

MSB  00000000  LSB
     RRRAAAMM

MM - message type
     00 - contains sensor data message
     01 - pairing, contains keys message
     10 - reserved
     11 - reserved

AAA - sensor address (if applicable)

RRR - reserved
*/

struct sensordatamessage {
    int8_t header = (myaddr << 2) + 0x00; // 1 byte
    sensordata data; // 16 bytes, will encrypt
};

struct sensorpairingmessage {
    int8_t header = (myaddr << 2) + 0x01; // 1 byte
    pairingdata data; // 16 bytes unencrypted
};

RF24 radio(8,9);
const uint64_t pipe = 0xFCFCFCFC00LL + (mychannel << 8) + myaddr;
//const uint64_t pipes[6] = { 0xF0F0F0F0E1LL, 0xF0F0F0F0D2LL }; 
BMP180 bsensor;
SI7021 hsensor;
byte encryptionkey[EEPROM_ENC_KEY_SIZE];
byte signaturekey[EEPROM_SIG_KEY_SIZE];

void setup() {
    // populate encryption key
    eeprom_read_block((void*)&encryptionkey, (const void*)EEPROM_ENC_KEY_ADDR, EEPROM_ENC_KEY_SIZE);
    if (keyIsEmpty(encryptionkey, EEPROM_ENC_KEY_SIZE)) {
        generateKey(encryptionkey, EEPROM_ENC_KEY_SIZE);
        eeprom_write_block((const void*)&encryptionkey, (void*)EEPROM_ENC_KEY_ADDR, EEPROM_ENC_KEY_SIZE);
    }

    // populate signature key
    eeprom_read_block((void*)&signaturekey, (const void*)EEPROM_SIG_KEY_ADDR, EEPROM_SIG_KEY_SIZE);
    if (keyIsEmpty(signaturekey, EEPROM_SIG_KEY_SIZE)) {
        generateKey(signaturekey, EEPROM_SIG_KEY_SIZE);
        eeprom_write_block((const void*)&signaturekey, (void*)EEPROM_SIG_KEY_ADDR, EEPROM_SIG_KEY_SIZE);
    }
    
    // turn off analog comparator
    ACSR = B10000000;
    // turn off digital input buffers for analog pins
    //DIDR0 = DIDR0 | B00111111;
    
    // turn off brown-out enable in software
    MCUCR = bit (BODS) | bit (BODSE);
    MCUCR = bit (BODS); 
    sleep_cpu ();
  
    pinMode(RF_GOOD_LED,OUTPUT);
    pinMode(RF_BAD_LED,OUTPUT);
    pinMode(LO_BATT_LED,OUTPUT);
  
    //flash lights on boot
    flash(RF_GOOD_LED);
    LowPower.powerDown(SLEEP_120MS, ADC_OFF, BOD_OFF);
    flash(RF_BAD_LED);
    LowPower.powerDown(SLEEP_120MS, ADC_OFF, BOD_OFF);
    flash(RF_GOOD_LED);
  
    //flash node address
    LowPower.powerDown(SLEEP_1S, ADC_OFF, BOD_OFF);
    for (int i = 0 ; i < myaddr; i++) {
        pulse(RF_GOOD_LED);   
    }
  
    radio.begin();
    radio.setRetries(6, 4);
    radio.setPayloadSize(PAYLOAD_SIZE);
    radio.setChannel(mychannel);
    radio.setDataRate(RF24_250KBPS);
    radio.setPALevel(RF24_PA_MAX);
    radio.openWritingPipe(pipe);
    radio.startListening();
    
    hsensor.begin();
    bsensor.begin(1);
    lastmillivolts = readVcc();

    //TESTING: proximity switch interrupt
    pinMode(PROXIMITY_PIN, INPUT_PULLUP);
    attachInterrupt(PROXIMITY_INT, proximityTrigger, HIGH);
}

void proximityTrigger() {
    if (abs(millis() - bounceTime) > BOUNCE_DURATION) {
        proximitytrigger = true;
        bounceTime = millis();
    }
}

void loop() {
    if (shouldEncrypt()) {
        sendDataMessage();
    } else {
        sendPairingMessage();
    }

    // power down for 56 seconds
    for (int i = 0; i < 7; i++) {
        LowPower.powerDown(SLEEP_8S, ADC_OFF, BOD_OFF);
// this seems unnecessary, as interrupt breaks the loop... ?
//        if (proximitytrigger == true) {
//            break;
//        }
    }
}

void sendDataMessage() {
    sensordatamessage m;
    // humidity, temp
    if (hsensor.sensorExists()) {
        si7021_env sidata = hsensor.getHumidityAndTemperature();
        m.data.humidity        = sidata.humidityBasisPoints;
        m.data.tempc           = sidata.celsiusHundredths;
    }

    // pressure
    if (bsensor.sensorExists()) {
        // fall back to bosch sensor for temperature if necessary
        if(! hsensor.sensorExists()) {
            m.data.tempc = bsensor.getCelsiusHundredths();
        }
        m.data.pressuredp = bsensor.getPressurePascals() / 10;

    }

    // voltage was read after last radio send to get reading after high power draw
    m.data.millivolts = lastmillivolts;

    if (digitalRead(PROXIMITY_PIN) == LOW) {
        m.data.proximity = true;
    } else {
        m.data.proximity = false;
    }
    proximitytrigger = false;
    // THIS SEEMS WRONG...CRUFT. DELETE IT IF THIS DOESN'T BREAK ANYTHING
    //attachInterrupt(PROXIMITY_INT, proximityTrigger, CHANGE);

    // when encryption is disabled, we send the key. when it is enabled, we send the empty key
    /*
    DELETE THIS WHEN WE HAVE NEW MESSAGES WORKING
    if (! shouldEncrypt()) {
        

        m.encrypted = true;
        // hmac the first 88 bits of the sensor data (everything but the signature itself)
        uint8_t hmac[16];
        hmac_md5(&hmac, &signaturekey, EEPROM_SIG_KEY_SIZE * 8, &m.s, 88);
        // populate the signature entry within sensor data, before we encrypt
        memcpy(&m.s.signature, &hmac, 5);

        // encrypt memory blocks containing sensor data. skipjack is 64 bit (8 byte) blocks
        for (int i = 0; i < sizeof(m.s); i += 8) {
            int ptrshift = i * 8;
            skipjack_enc((&m.s + ptrshift),&encryptionkey);
        }
    } else {
        memcpy(&m.enckey, &encryptionkey, EEPROM_ENC_KEY_SIZE);
        memcpy(&m.sigkey, &signaturekey, EEPROM_SIG_KEY_SIZE);
    }*/

    uint8_t hmac[16];
    hmac_md5(&hmac, &signaturekey, EEPROM_SIG_KEY_SIZE * 8, &m.data, 88);
    memcpy(&m.data.signature, &hmac, SIG_SIZE);
    // encrypt memory blocks containing sensor data. skipjack is 64 bit (8 byte) blocks
    for (int i = 0; i < sizeof(m.data); i += 8) {
        int ptrshift = i * 8;
        skipjack_enc((&m.data + ptrshift),&encryptionkey);
    }

    radio.powerUp();
    delay(2);
    radio.stopListening();
    bool ok = radio.write(&m, sizeof m);
    radio.startListening();
    radio.powerDown();

    if (ok) {
        flash(RF_GOOD_LED);
    } else {
        flash(RF_BAD_LED);
    }
    lastmillivolts = readVcc();

    if (m.data.millivolts < 2200) {
        flash(LO_BATT_LED);
    }
}

void sendPairingMessage() {
    sensorpairingmessage m;
    memcpy(&m.data.enckey, &encryptionkey, EEPROM_ENC_KEY_SIZE);
    memcpy(&m.data.sigkey, &signaturekey, EEPROM_SIG_KEY_SIZE);

    radio.powerUp();
    delay(2);
    radio.stopListening();
    bool ok = radio.write(&m, sizeof m);
    radio.startListening();
    radio.powerDown();

    if (ok) {
        flash(RF_GOOD_LED);
    } else {
        flash(RF_BAD_LED);
    }
}

void flash(int pin) {
  digitalWrite(pin, HIGH);
  delay(2);
  digitalWrite(pin, LOW);
  delay(2);
}

void pulse(int pin) {
   // software pwm, flash light for ~1 second with short duty cycle
   for (int i = 0; i < 50; i++) {
       digitalWrite(pin, HIGH);
       delay(1);
       digitalWrite(pin,LOW);
       delay(9);
   }
   digitalWrite(pin,LOW);
   LowPower.powerDown(SLEEP_500MS, ADC_OFF, BOD_OFF);   
}

// used for debugging, sending message output over rf
void rflog(char * msg) {
  radio.stopListening();
  
  bool ok = radio.write(msg, 32);
  if (ok) {
    flash(RF_GOOD_LED);
  } else {
    flash(RF_BAD_LED); 
  }
  radio.startListening();
}

long readVcc() {
  // Read 1.1V reference against AVcc
  // set the reference to Vcc and the measurement to the internal 1.1V reference
  #if defined(__AVR_ATmega32U4__) || defined(__AVR_ATmega1280__) || defined(__AVR_ATmega2560__)
    ADMUX = _BV(REFS0) | _BV(MUX4) | _BV(MUX3) | _BV(MUX2) | _BV(MUX1);
  #elif defined (__AVR_ATtiny24__) || defined(__AVR_ATtiny44__) || defined(__AVR_ATtiny84__)
    ADMUX = _BV(MUX5) | _BV(MUX0);
  #elif defined (__AVR_ATtiny25__) || defined(__AVR_ATtiny45__) || defined(__AVR_ATtiny85__)
    ADMUX = _BV(MUX3) | _BV(MUX2);
  #else
    ADMUX = _BV(REFS0) | _BV(MUX3) | _BV(MUX2) | _BV(MUX1);
  #endif  
  
  delay(2); // Wait for Vref to settle
  ADCSRA |= _BV(ADSC); // Start conversion
  while (bit_is_set(ADCSRA,ADSC)); // measuring
 
  uint8_t low  = ADCL; // must read ADCL first - it then locks ADCH  
  uint8_t high = ADCH; // unlocks both
 
  long result = (high<<8) | low;
 
  result = 1125300L / result; // Calculate Vcc (in mV); 1125300 = 1.1*1023*1000
  return result; // Vcc in millivolts
}

// read jumpers and get node address/id
int getMyAddr() {
    int result = 0;
    pinMode(ADDRESS_PIN_0, INPUT_PULLUP);
    pinMode(ADDRESS_PIN_1, INPUT_PULLUP);
    pinMode(ADDRESS_PIN_2, INPUT_PULLUP);
    
    if(!digitalRead(ADDRESS_PIN_2)) {
        result = result + 4;  
    }
    
    if(!digitalRead(ADDRESS_PIN_1)) {
        result = result + 2;  
    }
    
    if(!digitalRead(ADDRESS_PIN_0)) {
        result = result + 1 ;  
    }
    
    // save power
    pinMode(ADDRESS_PIN_0, OUTPUT);
    digitalWrite(ADDRESS_PIN_0, LOW);
    pinMode(ADDRESS_PIN_1, OUTPUT);
    digitalWrite(ADDRESS_PIN_1, LOW);
    pinMode(ADDRESS_PIN_2, OUTPUT);
    digitalWrite(ADDRESS_PIN_2, LOW);
    
    return result; 
}

int getMyChannel() {
    int result = 0;
    pinMode(CHANNEL_PIN_0, INPUT_PULLUP);
    pinMode(CHANNEL_PIN_1, INPUT_PULLUP);
    pinMode(CHANNEL_PIN_2, INPUT_PULLUP);
    pinMode(CHANNEL_PIN_3, INPUT_PULLUP);
    
    if(!digitalRead(CHANNEL_PIN_3)) {
        result = result + 8;  
    }
    
    if(!digitalRead(CHANNEL_PIN_2)) {
        result = result + 4;  
    }
    
    if(!digitalRead(CHANNEL_PIN_1)) {
        result = result + 2;  
    }
    
    if(!digitalRead(CHANNEL_PIN_0)) {
        result = result + 1 ;  
    }
    
    // save power
    pinMode(CHANNEL_PIN_0, OUTPUT);
    digitalWrite(CHANNEL_PIN_0, LOW);
    pinMode(CHANNEL_PIN_1, OUTPUT);
    digitalWrite(CHANNEL_PIN_1, LOW);
    pinMode(CHANNEL_PIN_2, OUTPUT);
    digitalWrite(CHANNEL_PIN_2, LOW);
    pinMode(CHANNEL_PIN_3, OUTPUT);
    digitalWrite(CHANNEL_PIN_3, LOW);

    for (int i = 0 ; i < result; i++) {
        pulse(LO_BATT_LED);
    } 

    // we use channels 60-75
    result += 60;

    return result;
}

bool shouldEncrypt() {
    boolean result = false;
    pinMode(ENCRYPT_PIN, INPUT_PULLUP);
    
    if(!digitalRead(ENCRYPT_PIN)) {
        result = true;   
    }
    
    pinMode(ENCRYPT_PIN, OUTPUT);
    digitalWrite(ENCRYPT_PIN, LOW);
    
    return result;
}

bool keyIsEmpty(byte * key, int size) {
    for (int i = 0; i < size; i++) {
        if (key[i] != 0xff) {
            return false;   
        }
    }
    return true;
}

void generateKey(byte * key, int size) {
   randomSeed(analogRead(A0));
   for (int i = 0; i < size; i++) {
       key[i] = (unsigned char) random(0,255);  
   } 
}
