// Nest dependencies
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { InjectRepository } from '@nestjs/typeorm'

// Other dependencies
import * as jwt from 'jsonwebtoken'

// Local files
import { configService } from 'src/shared/Services/config.service'
import { UsersEntity } from 'src/shared/Entities/users.entity'
import { RedisService } from 'src/shared/Services/redis.service'
import { MailSenderBody } from 'src/shared/Services/types'
import { UsersRepository } from 'src/shared/Repositories/users.repository'
import { MailService } from 'src/shared/Services/mail.service'
import { CreateAccountDto } from '../Dto/create-account.dto'
import { LoginDto } from '../Dto/login.dto'
import { GenerateRecoveryKeyDto } from '../Dto/generate-recovery-key.dto'
import { serializerService, ISerializeResponse } from 'src/shared/Services/serializer.service'
import { jwtManipulationService } from 'src/shared/Services/jwt.manipulation.service'
import { RecoverAccountDto } from '../Dto/recover-account.dto'
import { sitemapManipulationService } from 'src/shared/Services/sitemap.manipulation.service'
import { StatusOk } from 'src/shared/Types'

@Injectable()
export class AuthService {
    constructor(
        private readonly jwtService: JwtService,
        private readonly redisService: RedisService,
        private readonly mailService: MailService,
        @InjectRepository(UsersRepository)
        private readonly usersRepository: UsersRepository,
    ) {}

    async signUp(dto: CreateAccountDto): Promise<StatusOk> {
        let user
        user = await this.usersRepository.find({
        where: {
            $or: [
                { username: dto.username },
                { email: dto.email }
            ]
        }
        })

        if (user[0]) throw new BadRequestException('Account already exists')
        user = await this.redisService.getData(dto.username)
        if (user) throw new BadRequestException('Account is already created but not verified')

        const verifyToken = jwt.sign({
            username: dto.username,
            email: dto.email,
            verificationToken: true,
            exp: Math.floor(Date.now() / 1000) + (120 * 60), // Token expires in 120 min
        }, configService.getEnv('SECRET_FOR_ACCESS_TOKEN'))

        const verificationUrl: string = `${configService.getEnv('APP_DOMAIN')}/auth/sign-up/account-verification?token=${verifyToken}`

        const mailBody: MailSenderBody = {
            receiverEmail: dto.email,
            receiverFullname: dto.fullName,
            subject: `Verify Your Account [${dto.username}]`,
            text: verificationUrl,
        }

        await this.mailService.sendVerificationMail(mailBody).catch(_error => {
            throw new BadRequestException('SMTP transport failed')
        })

        await this.redisService.setData(dto.username, JSON.stringify(dto), 7200)
        return { status: 'ok', message: 'Account has been created. Please verify your account to be able to sign in' }
    }

    async signIn(userEntity: UsersEntity, dto: LoginDto): Promise<ISerializeResponse> {
        if (userEntity.is_banned) throw new BadRequestException('Account is banned')
        if (!userEntity.is_active) throw new BadRequestException('Account is not active')

        const token: string = this.jwtService.sign({
            role: userEntity.role,
            username: userEntity.username,
            email: userEntity.email,
            created_at: userEntity.created_at
        })

        if (dto.rememberMe) userEntity.refresh_token = await this.usersRepository.triggerRefreshToken(dto.email || dto.username)

        const id: any = userEntity.id
        const properties: string[] = ['id', 'password', 'recovery_key', 'refresh_token']
        await serializerService.deleteProperties(userEntity, properties)

        const responseData: object = {
            access_token: token,
            user: userEntity,
        }

        return serializerService.serializeResponse('user_information', responseData, id)
    }

    async signOut(bearer: string): Promise<StatusOk> {
        const decodedToken: any = jwtManipulationService.decodeJwtToken(bearer, 'all')
        await this.usersRepository.triggerRefreshToken(decodedToken.username)
        const expireDate: number = decodedToken.exp
        const remainingSeconds: number = Math.round(expireDate - Date.now() / 1000)

        await this.redisService.setOnlyKey(bearer.split(' ')[1], remainingSeconds)
        return { status: 'ok', message: 'Token is killed' }
    }

    async refreshToken(refreshToken: string): Promise<ISerializeResponse> {
        let decodedToken

        try {
            decodedToken = jwt.verify(refreshToken, configService.getEnv('SECRET_FOR_REFRESH_TOKEN'))
        } catch (error) {
            throw new BadRequestException('Token signature is not valid')
        }

        let user: UsersEntity

        try {
            user = await this.usersRepository.findOneOrFail({
                username: decodedToken.username,
                refresh_token: refreshToken
            })
        } catch (e) {
            throw new BadRequestException('Refresh token is not valid')
        }

        const refreshedToken = this.jwtService.sign({
            id: user.id,
            role: user.role,
            username: user.username,
            email: user.email,
            created_at: user.created_at
        })

        return serializerService.serializeResponse('refreshed_access_token', { access_token: refreshedToken })
    }

    async validateUser(dto: LoginDto): Promise<UsersEntity> {
        return await this.usersRepository.validateUser(dto)
    }

    async generateRecoveryKey(dto: GenerateRecoveryKeyDto): Promise<StatusOk> {
        const { account, generatedKey }  = await this.usersRepository.generateRecoveryKey(dto)

        const mailBody: MailSenderBody = {
            receiverEmail: dto.email,
            receiverFullname: account.full_name,
            subject: `Account Recovery [${account.username}]`,
            text: `${configService.getEnv('APP_DOMAIN')}/auth/sign-in/account-recover?email=${dto.email}&recoveryKey=${generatedKey}`,
        }

        await this.mailService.sendRecoveryMail(mailBody).catch(_error => {
            throw new BadRequestException('SMTP transport failed')
        })

        return { status: 'ok', message: 'Recovery key has been sent to email address' }
    }

    async recoverAccount(dto: RecoverAccountDto): Promise<StatusOk> {
        await this.usersRepository.getUserByEmail(dto.email)
        await this.usersRepository.recoverAccount(dto)
        return { status: 'ok', message: 'Password has been successfully updated' }
    }

    async accountVerification(incToken: string): Promise<StatusOk> {
        let decodedToken
        try {
            decodedToken = jwt.verify(incToken, configService.getEnv('SECRET_FOR_ACCESS_TOKEN'))
        } catch (error) {
            throw new BadRequestException('Token signature is not valid')
        }

        if (decodedToken.verificationToken && decodedToken.username) {
            const remainingTime: number = await decodedToken.exp - Math.floor(Date.now() / 1000)
            if (remainingTime <= 0) {
                throw new BadRequestException('Verification token is no longer valid, its expired')
            }

            const accountInformation = await this.redisService.getData(decodedToken.username)
            if (!accountInformation) throw new NotFoundException('Account could not found')

            await this.usersRepository.createUser(JSON.parse(accountInformation))
            await this.redisService.deleteData(decodedToken.username)
            sitemapManipulationService.addToIndexedSitemap(`user/${decodedToken.username}`)

            return { status: 'ok', message: 'Account has been verified' }
        }

        throw new BadRequestException('Token is not valid')
    }
}
