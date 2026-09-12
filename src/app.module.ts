import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { UserModule } from './user/user.module';
import { EventModule } from './event/event.module';
import { BedroomsModule } from './bedrooms/bedrooms.module';
import { TeamModule } from './team/team.module';
import { AuthController } from './auth/auth.controller';
import { AuthModule } from './auth/auth.module';
import { PasswordResetModule } from './auth/password-reset/password-reset.module';
import { GatewaysModule } from './gateways/gateways.module';
import { CryptoModule } from './crypto/crypto.module';
import { PaymentModule } from './payment/payment.module';
import { PaymentProviderModule } from './payment-providers/payment-provider.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { CronModule } from './cron/cron.module';
import { CheckinModule } from './checkin/checkin.module';
import { NewsModule } from './news/news.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { LogsModule } from './logs/logs.module';
import { ChurchModule } from './church/church.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestContextInterceptor } from './middleware/request-context.middleware';

@Module({
  imports: [
    PrismaModule,
    UserModule,
    EventModule,
    BedroomsModule,
    TeamModule,
    AuthModule,
    PasswordResetModule,
    CryptoModule,
    GatewaysModule,
    PaymentModule,
    PaymentProviderModule,
    WebhooksModule,
    CronModule,
    CheckinModule,
    NewsModule,
    WhatsappModule,
    LogsModule,
    ChurchModule,
    DashboardModule,
  ],
  controllers: [AuthController],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestContextInterceptor,
    },
  ],
})
export class AppModule {}
