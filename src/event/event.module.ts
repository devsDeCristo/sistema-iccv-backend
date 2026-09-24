import { Module } from '@nestjs/common';
import { EventService } from './event.service';
import { EventController } from './event.controller';
import { GatewaysModule } from 'src/gateways/gateways.module';
import { MailModule } from 'src/mail/mail.module';

@Module({
  imports: [MailModule, GatewaysModule],
  controllers: [EventController],
  providers: [EventService],
  exports: [EventService],
})
export class EventModule {}
