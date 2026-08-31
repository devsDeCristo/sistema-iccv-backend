import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET,
    });
  }

  async validate(payload: any) {
    // `role` e `churchId` são só pistas vindas do token (podem estar defasadas
    // por até 24h — o vínculo pode ter mudado depois do login). A autorização de
    // verdade lê o banco: o perfil no RolesGuard e a igreja em `src/auth/tenant.ts`.
    // Nenhum recorte de igreja deve ser decidido a partir daqui.
    return {
      userId: payload.sub,
      username: payload.username,
      role: payload.role,
      churchId: payload.churchId || null,
    };
  }
}
