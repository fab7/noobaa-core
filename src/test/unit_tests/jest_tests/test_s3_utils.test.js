/* Copyright (C) 2016 NooBaa */
'use strict';

const s3_utils = require('../../../endpoint/s3/s3_utils');
const { S3Error } = require('../../../endpoint/s3/s3_errors');
const config = require('../../../../config');

function create_dummy_nb_response() {
    return {
        headers: {},
        setHeader: function(k, v) {
            if (Array.isArray(v)) {
                v = v.join(',');
            }

            this.headers[k] = v;
        }
    };
}

describe('s3_utils', () => {
    describe('parse_restrore_request_days', () => {
        it('should parse correctly when 0 < days < max days', () => {
            const req = {
                body: {
                    RestoreRequest: { Days: [1] }
                }
            };

            const days = s3_utils.parse_restore_request_days(req);
            expect(days).toBe(1);
        });

        it('should fail when days < 1', () => {
            const req = {
                body: {
                    RestoreRequest: { Days: [0] }
                }
            };

            expect(() => s3_utils.parse_restore_request_days(req)).toThrow(S3Error);
        });

        it('should fail when days > max_days - behaviour DENY', () => {
            const req = {
                body: {
                    RestoreRequest: { Days: [config.S3_RESTORE_REQUEST_MAX_DAYS + 1] }
                }
            };

            const initial = config.S3_RESTORE_REQUEST_MAX_DAYS_BEHAVIOUR;
            config.S3_RESTORE_REQUEST_MAX_DAYS_BEHAVIOUR = 'DENY';
            expect(() => s3_utils.parse_restore_request_days(req)).toThrow(S3Error);
            config.S3_RESTORE_REQUEST_MAX_DAYS_BEHAVIOUR = initial;
        });

        it('should succeed when days > max_days - behaviour TRUNCATE', () => {
            const req = {
                body: {
                    RestoreRequest: { Days: [config.S3_RESTORE_REQUEST_MAX_DAYS + 1] }
                }
            };

            const initial = config.S3_RESTORE_REQUEST_MAX_DAYS_BEHAVIOUR;
            config.S3_RESTORE_REQUEST_MAX_DAYS_BEHAVIOUR = 'TRUNCATE';

            const days = s3_utils.parse_restore_request_days(req);
            expect(days).toBe(config.S3_RESTORE_REQUEST_MAX_DAYS);

            config.S3_RESTORE_REQUEST_MAX_DAYS_BEHAVIOUR = initial;
        });
    });

    describe('set_response_object_md', () => {
        it('should return no restore status when restore_status is absent', () => {
            const object_md = {
                xattr: {}
            };
            const res = create_dummy_nb_response();

            // @ts-ignore
            s3_utils.set_response_object_md(res, object_md);

            expect(res.headers['x-amz-restore']).toBeUndefined();
        });

        it('should return restore status when restore is requested and ongoing', () => {
            const object_md = {
                xattr: {},
                restore_status: {
                    ongoing: true,
                },
            };
            const res = create_dummy_nb_response();

            // @ts-ignore
            s3_utils.set_response_object_md(res, object_md);

            expect(res.headers['x-amz-restore']).toBeDefined();
        });

        it('should return restore status when restore is completed', () => {
            const object_md = {
                xattr: {},
                restore_status: {
                    ongoing: false,
                    expiry_time: new Date(),
                },
            };
            const res = create_dummy_nb_response();

            // @ts-ignore
            s3_utils.set_response_object_md(res, object_md);

            expect(res.headers['x-amz-restore']).toBeDefined();
        });
    });
});
