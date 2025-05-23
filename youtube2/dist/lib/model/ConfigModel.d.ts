import { BaseModel } from './BaseModel';
import { type I18nOptions, type PluginConfigSchema } from '../types/PluginConfig';
export declare const PLUGIN_CONFIG_SCHEMA: PluginConfigSchema;
export default class ConfigModel extends BaseModel {
    getI18nOptions(): Promise<I18nOptions>;
    clearCache(): void;
    getRootContentTypeOptions(): {
        label: string;
        value: string;
    }[];
    getLiveStreamQualityOptions(): {
        label: string;
        value: string;
    }[];
    getDefaultI18nOptions(): {
        region: {
            label: string;
            optionValues: {
                label: string;
                value: string;
            }[];
        };
        language: {
            label: string;
            optionValues: {
                label: string;
                value: string;
            }[];
        };
    };
}
//# sourceMappingURL=ConfigModel.d.ts.map