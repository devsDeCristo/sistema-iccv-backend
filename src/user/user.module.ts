import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from 'src/auth/jwt.strategy/jwt.strategy';
import { EventModule } from 'src/event/event.module';
import { MailModule } from 'src/mail/mail.module';

@Module({
  imports: [
    EventModule,
    // aviso ao e-mail antigo quando outra pessoa troca o e-mail da conta
    MailModule,
    UserModule,
    //PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'default_secret',
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [UserController],
  providers: [UserService, JwtStrategy],
  exports: [UserService],
})
export class UserModule {}
