import { logger } from '../utils/logger.js';

const FIELD_TRANSFORMS = {
    'address_type': { value: 'DELIVERY', check: (v) => typeof v === 'string' && v.startsWith('XX') }, // TODO: address type should be dynamic
    'mobile_number': { value: '9876543210', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'phone': { value: '9876543210', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'date_of_birth': { value: '01-01-1990', check: (v) => typeof v === 'string' && (v.startsWith('XX') || v === 'MASKED') },
    'dateOfBirth': { value: '01-01-1990', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'pan_number': { value: 'EHZPA1234F', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'pan': { value: 'EHZPA1234F', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'first_name': { value: 'TestFirst', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'firstName': { value: 'TestFirst', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'last_name': { value: 'TestLast', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'lastName': { value: 'TestLast', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'email': { value: 'test@juspay.in', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'email_id': { value: 'test@juspay.in', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'address_line_1': { value: '123 Test Street', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'address_line_2': { value: 'Near Test Park', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'state': { value: 'Maharashtra', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'city': { value: 'Pune', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'pincode': { value: '560047', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'employment_type': { value: 'SALARIED', check: (v) => typeof v === 'string' && v.startsWith('XX') },
    'marital_status': { value: 'SINGLE', check: (v) => typeof v === 'string' && v.startsWith('XX') }
};

const EXPIRY_TIME_FIELDS = [
    'order_expiry_time',
    'expiry_time',
    'expiration_time',
    'expiry_at',
    'orderExpiry',
    'expiryAt',
    'expires_at'
];

function isMasked(value) {
    return typeof value === 'string' && (value.startsWith('XX') || value === 'MASKED');
}

function isISOTimestamp(value) {
    if (typeof value !== 'string') return false;
    const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
    return isoRegex.test(value) && !Number.isNaN(Date.parse(value));
}

function generateFutureTimestamp(minutesFromNow) {
    const now = new Date();
    now.setMinutes(now.getMinutes() + minutesFromNow);
    return now.toISOString();
}

function transformValue(key, value) {
    const transform = FIELD_TRANSFORMS[key];
    if (transform && transform.check(value)) {
        return { transformed: true, value: transform.value };
    }
    if (value === 'MASKED') {
        return { transformed: true, value: null };
    }
    return { transformed: false, value };
}

function traverseAndTransform(obj, path, transformsApplied) {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            obj[i] = traverseAndTransform(obj[i], path + '[' + i + ']', transformsApplied);
        }
        return obj;
    }

    if (typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
            const value = obj[key];
            const currentPath = path ? path + '.' + key : key;

            if (typeof value === 'string' && isMasked(value)) {
                const result = transformValue(key, value);
                if (result.transformed) {
                    obj[key] = result.value;
                    transformsApplied.push({
                        path: currentPath,
                        key: key,
                        oldValue: value,
                        newValue: result.value
                    });
                }
            } else if (typeof value === 'object') {
                obj[key] = traverseAndTransform(value, currentPath, transformsApplied);
            }
        }
        return obj;
    }

    return obj;
}

function traverseAndUpdateExpiry(obj, path, transformsApplied, minutesFromNow) {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            obj[i] = traverseAndUpdateExpiry(obj[i], path + '[' + i + ']', transformsApplied, minutesFromNow);
        }
        return obj;
    }

    if (typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
            const value = obj[key];
            const currentPath = path ? path + '.' + key : key;

            if (EXPIRY_TIME_FIELDS.includes(key) && isISOTimestamp(value)) {
                const newValue = generateFutureTimestamp(minutesFromNow);
                obj[key] = newValue;
                transformsApplied.push({
                    path: currentPath,
                    key: key,
                    oldValue: value,
                    newValue: newValue,
                    description: 'Updated expiry time to +' + minutesFromNow + ' minutes'
                });
            } else if (typeof value === 'object') {
                obj[key] = traverseAndUpdateExpiry(value, currentPath, transformsApplied, minutesFromNow);
            }
        }
        return obj;
    }

    return obj;
}

function transformBureauData(obj, path, transformsApplied) {
    if (obj === null || obj === undefined) return obj;

    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            obj[i] = transformBureauData(obj[i], path + '[' + i + ']', transformsApplied);
        }
        return obj;
    }

    if (typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
            const value = obj[key];
            const currentPath = path ? path + '.' + key : key;

            if (key === 'bureau' && typeof value === 'string' && value !== 'MASKED') {
                const bureauData = {
                    format: 'JSON',
                    value: value,
                    source: value,
                    is_encrypted: false
                };
                obj[key] = bureauData;
                transformsApplied.push({
                    path: currentPath,
                    key: key,
                    oldValue: value,
                    newValue: bureauData,
                    description: 'Transformed string bureau to BureauData object'
                });
            } else if (typeof value === 'object') {
                obj[key] = transformBureauData(value, currentPath, transformsApplied);
            }
        }
        return obj;
    }

    return obj;
}

function transformDeliveryAddress(obj, transformsApplied) {
    if (!obj || typeof obj !== 'object') return obj;

    if (obj.delivery_address === null || obj.delivery_address === undefined) {
        if (Array.isArray(obj.address) && obj.address.length > 0) {
            const deliveryAddr = obj.address.find(addr => addr && addr.address_type === 'DELIVERY');
            if (deliveryAddr) {
                obj.delivery_address = deliveryAddr;
                transformsApplied.push({
                    path: 'delivery_address',
                    key: 'delivery_address',
                    oldValue: null,
                    newValue: deliveryAddr,
                    description: 'Extracted delivery address from address array'
                });
            }
        }
    }
    return obj;
}

function transformIsAccountAggregatorRequired(obj, path, transformsApplied) {
    if (obj === null || obj === undefined) return obj;

    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            obj[i] = transformIsAccountAggregatorRequired(obj[i], path + '[' + i + ']', transformsApplied);
        }
        return obj;
    }

    if (typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
            const currentPath = path ? path + '.' + key : key;

            if (key === 'isAccountAggregatorRequired' && obj[key] === null) {
                const newValue = {
                    value: false,
                    type: 'BOOLEAN'
                };
                transformsApplied.push({
                    path: currentPath,
                    key: key,
                    oldValue: null,
                    newValue: newValue,
                    description: 'Converted null isAccountAggregatorRequired to BOOLEAN object'
                });
                obj[key] = newValue;
            } else if (typeof obj[key] === 'object') {
                obj[key] = transformIsAccountAggregatorRequired(obj[key], currentPath, transformsApplied);
            }
        }
        return obj;
    }

    return obj;
}

function transformRiskDetails(obj, path, transformsApplied) {
    if (obj === null || obj === undefined) return obj;

    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            obj[i] = transformRiskDetails(
                obj[i],
                path + '[' + i + ']',
                transformsApplied
            );
        }
        return obj;
    }

    if (typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
            const currentPath = path ? path + '.' + key : key;

            if ((key === 'risk_details' || key === 'riskDetails') && (obj[key] === 'MASKED' || obj[key] === null)) {
                const newValue = {
                    "risk_score": "82",
                    "risk_level": "HIGH",
                    "fraud_flag": "true",
                    "source": "bureau"
                };

                transformsApplied.push({
                    path: currentPath,
                    key: key,
                    oldValue: obj[key],
                    newValue: newValue,
                    description: 'Converted MASKED/null risk_details to sample object'
                });

                obj[key] = newValue;
            } else if (typeof obj[key] === 'object') {
                obj[key] = transformRiskDetails(
                    obj[key],
                    currentPath,
                    transformsApplied
                );
            }
        }

        return obj;
    }

    return obj;
}

export function transformMaskedValues(payload, context) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }

    const transformsApplied = [];
    const transformedPayload = traverseAndTransform(payload, '', transformsApplied);

    if (transformsApplied.length > 0) {
        logger.info('Transformed masked values in request', {
            context: context || '',
            count: transformsApplied.length,
            transforms: transformsApplied
        });
    }

    return transformedPayload;
}

export function transformExpiryTimes(payload, context, minutesFromNow) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }

    const minutes = minutesFromNow || 10;
    const transformsApplied = [];
    const transformedPayload = traverseAndUpdateExpiry(payload, '', transformsApplied, minutes);

    if (transformsApplied.length > 0) {
        logger.info('Transformed expiry times in request', {
            context: context || '',
            minutesFromNow: minutes,
            transforms: transformsApplied
        });
    }

    return transformedPayload;
}

export function transformRequest(payload, context) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }

    let transformedPayload = payload;

    transformedPayload = transformMaskedValues(transformedPayload, context);
    transformedPayload = transformExpiryTimes(transformedPayload, context, 10);

    const deliveryTransforms = [];
    transformedPayload = transformDeliveryAddress(transformedPayload, deliveryTransforms);

    if (deliveryTransforms.length > 0) {
        logger.info('Transformed delivery address in request', {
            context: context || '',
            transforms: deliveryTransforms
        });
    }

    const bureauTransforms = [];
    transformedPayload = transformBureauData(transformedPayload, '', bureauTransforms);

    if (bureauTransforms.length > 0) {
        logger.info('Transformed bureau fields in request', {
            context: context || '',
            count: bureauTransforms.length,
            transforms: bureauTransforms
        });
    }

    const aaTransforms = [];
    transformedPayload = transformIsAccountAggregatorRequired(transformedPayload, '', aaTransforms);

    if (aaTransforms.length > 0) {
        logger.info('Transformed isAccountAggregatorRequired in request', {
            context: context || '',
            count: aaTransforms.length,
            transforms: aaTransforms
        });
    }
    const riskTransform = [];
    transformedPayload = transformRiskDetails(transformedPayload, '', riskTransform);

    if (riskTransform.length > 0) {
        logger.info('Transformed risk details in request', {
            context: context || '',
            count: riskTransform.length,
            transforms: riskTransform
        });
    }

    return transformedPayload;
}

export function addMaskedTransform(fieldName, replacementValue, checkFn) {
    FIELD_TRANSFORMS[fieldName] = {
        value: replacementValue,
        check: checkFn || function(v) { return typeof v === 'string' && v.startsWith('XX'); }
    };
    logger.info('Added masked field transform', { field: fieldName });
}

export function addExpiryTimeField(fieldName) {
    if (!EXPIRY_TIME_FIELDS.includes(fieldName)) {
        EXPIRY_TIME_FIELDS.push(fieldName);
        logger.info('Added expiry time field', { field: fieldName });
    }
}

export function getMaskedTransforms() {
    return Object.assign({}, FIELD_TRANSFORMS);
}

export function getExpiryTimeFields() {
    return EXPIRY_TIME_FIELDS.slice();
}

export function removeMaskedTransform(fieldName) {
    delete FIELD_TRANSFORMS[fieldName];
    logger.info('Removed masked field transform', { field: fieldName });
}

export function removeExpiryTimeField(fieldName) {
    const index = EXPIRY_TIME_FIELDS.indexOf(fieldName);
    if (index > -1) {
        EXPIRY_TIME_FIELDS.splice(index, 1);
        logger.info('Removed expiry time field', { field: fieldName });
    }
}

export default transformRequest;
